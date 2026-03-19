#!/bin/sh
set -e

# fixbot Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/ukint-vs/fixbot/main/scripts/install.sh | sh
#
# Options:
#   --source       Install via bun (installs bun if needed)
#   --binary       Always install prebuilt binary
#   --ref <ref>    Install specific tag/commit/branch
#   -r <ref>       Shorthand for --ref

REPO="ukint-vs/fixbot"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
MIN_BUN_VERSION="1.3.7"

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# If a ref is provided, default to source install
if [ -n "$REF" ] && [ -z "$MODE" ]; then
    MODE="source"
fi

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read bun version"
        exit 1
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Bun at https://bun.sh/docs/installation"
        exit 1
    fi
}

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

# Install bun
install_bun() {
    echo "Installing bun..."
    if command -v bash >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
    else
        echo "bash not found; attempting install with sh..."
        curl -fsSL https://bun.sh/install | sh
    fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

# Install via bun from source
# Clones the repo to ~/.fixbot/source and creates a wrapper script in INSTALL_DIR.
# workspace:* dependencies require the full monorepo context, so we keep the clone.
install_via_bun() {
    echo "Installing fixbot from source..."
    if ! has_git; then
        echo "git is required for source install"
        exit 1
    fi

    SOURCE_DIR="$HOME/.fixbot/source"
    CLONE_REF="${REF:-main}"

    mkdir -p "$(dirname "$SOURCE_DIR")"

    if [ -d "$SOURCE_DIR/.git" ]; then
        # Existing clone — fetch and reset to target ref (preserves target/ cache)
        echo "Updating existing source install..."
        (cd "$SOURCE_DIR" && git fetch origin "$CLONE_REF" --depth 1 2>/dev/null && git reset --hard FETCH_HEAD 2>/dev/null) || {
            # Fetch failed (ref changed type, shallow history issue) — re-clone
            # but preserve cargo target/ directory to avoid full rebuild
            CACHED_TARGET=""
            if [ -d "$SOURCE_DIR/target" ]; then
                CACHED_TARGET="$(mktemp -d)"
                mv "$SOURCE_DIR/target" "$CACHED_TARGET/target"
            fi
            rm -rf "$SOURCE_DIR"
            git clone --depth 1 --branch "$CLONE_REF" "https://github.com/${REPO}.git" "$SOURCE_DIR" 2>/dev/null || {
                git clone "https://github.com/${REPO}.git" "$SOURCE_DIR"
                (cd "$SOURCE_DIR" && git checkout "$CLONE_REF" 2>/dev/null)
            }
            if [ -n "$CACHED_TARGET" ] && [ -d "$CACHED_TARGET/target" ]; then
                mv "$CACHED_TARGET/target" "$SOURCE_DIR/target"
                rm -rf "$CACHED_TARGET"
            fi
        }
    else
        # Fresh install
        if git clone --depth 1 --branch "$CLONE_REF" "https://github.com/${REPO}.git" "$SOURCE_DIR" 2>/dev/null; then
            :
        else
            git clone "https://github.com/${REPO}.git" "$SOURCE_DIR"
            (cd "$SOURCE_DIR" && git checkout "$CLONE_REF" 2>/dev/null)
        fi
    fi

    # Pull LFS files
    if has_git_lfs; then
        (cd "$SOURCE_DIR" && git lfs pull >/dev/null 2>&1)
    fi

    if [ ! -d "$SOURCE_DIR/packages/coding-agent" ]; then
        echo "Expected package at ${SOURCE_DIR}/packages/coding-agent"
        exit 1
    fi

    echo "Installing dependencies..."
    (cd "$SOURCE_DIR" && bun install) || {
        echo "Failed to install dependencies"
        exit 1
    }

    # Build native addons (requires Rust toolchain)
    # Skip if the .node binary already exists (cached from previous build)
    NATIVE_NODE="$SOURCE_DIR/packages/natives/native/pi_natives.$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/').node"
    if [ -f "$NATIVE_NODE" ]; then
        echo "Native addon already built — skipping cargo build"
    elif command -v cargo >/dev/null 2>&1; then
        echo "Building native addons..."
        (cd "$SOURCE_DIR" && bun run build:native) || {
            echo "⚠ Native addon build failed. fixbot will work but some features (search, media) may be slower."
            echo "  To retry later: cd ${SOURCE_DIR} && bun run build:native"
        }
    else
        echo "⚠ Rust toolchain not found — skipping native addon build."
        echo "  fixbot will work but some features (search, media) may be slower."
        echo "  Install Rust (https://rustup.rs) then run: cd ${SOURCE_DIR} && bun run build:native"
    fi

    # Create wrapper script
    mkdir -p "$INSTALL_DIR"
    cat > "${INSTALL_DIR}/fixbot" <<WRAPPER
#!/bin/sh
exec bun run "$SOURCE_DIR/packages/coding-agent/src/cli.ts" "\$@"
WRAPPER
    chmod +x "${INSTALL_DIR}/fixbot"

    echo ""
    echo "✓ Installed fixbot via bun"
    echo "  Source: ${SOURCE_DIR}"
    echo "  Binary: ${INSTALL_DIR}/fixbot"

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'fixbot' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'fixbot'" ;;
    esac
}

# Install binary from GitHub releases
install_binary() {
    # Detect platform
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  ARCH="x64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    BINARY="fixbot-${PLATFORM}-${ARCH}"
    # Get release tag
    if [ -n "$REF" ]; then
        echo "Fetching release $REF..."
        if RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/tags/${REF}"); then
            LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
        else
            echo "Release tag not found: $REF"
            echo "For branch/commit installs, use --source with --ref."
            exit 1
        fi
    else
        echo "Fetching latest release..."
        RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")
        LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    fi

    if [ -z "$LATEST" ]; then
        echo "Failed to fetch release tag"
        exit 1
    fi
    echo "Using version: $LATEST"

    mkdir -p "$INSTALL_DIR"
    # Download binary
    BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    echo "Downloading ${BINARY}..."
    curl -fsSL "$BINARY_URL" -o "${INSTALL_DIR}/fixbot"
    chmod +x "${INSTALL_DIR}/fixbot"
    downloaded_native=0
    if [ "$ARCH" = "x64" ]; then
        for variant in modern baseline; do
            NATIVE_ADDON="pi_natives.${PLATFORM}-${ARCH}-${variant}.node"
            NATIVE_URL="https://github.com/${REPO}/releases/download/${LATEST}/${NATIVE_ADDON}"
            echo "Downloading ${NATIVE_ADDON}..."
            curl -fsSL "$NATIVE_URL" -o "${INSTALL_DIR}/${NATIVE_ADDON}" || {
                echo "Failed to download ${NATIVE_ADDON}"
                exit 1
            }
            downloaded_native=$((downloaded_native + 1))
        done
    else
        NATIVE_ADDON="pi_natives.${PLATFORM}-${ARCH}.node"
        NATIVE_URL="https://github.com/${REPO}/releases/download/${LATEST}/${NATIVE_ADDON}"
        echo "Downloading ${NATIVE_ADDON}..."
        curl -fsSL "$NATIVE_URL" -o "${INSTALL_DIR}/${NATIVE_ADDON}"
        downloaded_native=1
    fi
    echo ""
    echo "✓ Installed fixbot to ${INSTALL_DIR}/fixbot"
    echo "✓ Installed ${downloaded_native} native addon file(s) to ${INSTALL_DIR}"

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'fixbot' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'fixbot'" ;;
    esac
}

# Main logic
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        install_via_bun
        ;;
    binary)
        install_binary
        ;;
    *)
        # Default: use bun if available, otherwise binary
        if has_bun; then
            require_bun_version
            install_via_bun
        else
            install_binary
        fi
        ;;
esac
