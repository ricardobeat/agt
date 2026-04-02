#!/usr/bin/env bash
# Package agt.rb as a self-contained binary using traveling-ruby.
# Produces: dist/agt-<version>-osx-arm64.tar.gz

set -euo pipefail

VERSION="${1:-1.0.0}"
RUBY_VERSION="3.3.6"
TR_DATE="20250413"
PLATFORM="osx-arm64"
PKG_NAME="agt-${VERSION}-${PLATFORM}"
DIST_DIR="dist"
WORK_DIR="${DIST_DIR}/${PKG_NAME}"
TR_URL="https://github.com/phusion/traveling-ruby/releases/download/${TR_DATE}-${RUBY_VERSION}/traveling-ruby-${TR_DATE}-${RUBY_VERSION}-${PLATFORM}.tar.gz"
TR_TARBALL="${DIST_DIR}/traveling-ruby-${PLATFORM}.tar.gz"

mkdir -p "${WORK_DIR}/lib"

# Download traveling-ruby if not cached
if [[ ! -f "${TR_TARBALL}" ]]; then
  echo "Downloading traveling-ruby ${RUBY_VERSION} for ${PLATFORM}..."
  curl -fL "${TR_URL}" -o "${TR_TARBALL}"
fi

# Extract ruby runtime
echo "Extracting ruby runtime..."
mkdir -p "${WORK_DIR}/lib/ruby"
tar -xzf "${TR_TARBALL}" -C "${WORK_DIR}/lib/ruby"

# Copy the script
cp agt.rb "${WORK_DIR}/lib/agt.rb"

# Create the launcher
cat > "${WORK_DIR}/agt" <<'EOF'
#!/usr/bin/env bash
set -e
SELFDIR="$(cd "$(dirname "$0")" && pwd)"
exec "${SELFDIR}/lib/ruby/bin/ruby" "${SELFDIR}/lib/agt.rb" "$@"
EOF
chmod +x "${WORK_DIR}/agt"

# Package
echo "Creating tarball..."
tar -czf "${DIST_DIR}/${PKG_NAME}.tar.gz" -C "${DIST_DIR}" "${PKG_NAME}"

echo "Done: ${DIST_DIR}/${PKG_NAME}.tar.gz"
echo ""
echo "Install with:"
echo "  tar -xzf ${DIST_DIR}/${PKG_NAME}.tar.gz -C ~/tools"
echo "  ln -sf ~/tools/${PKG_NAME}/agt /usr/local/bin/agt"
