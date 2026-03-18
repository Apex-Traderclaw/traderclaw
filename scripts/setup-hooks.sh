#!/bin/bash
# Setup script for installing git hooks and configurations
# Run this after cloning or extracting the repository

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "📦 Setting up Git hooks and permissions..."

# Install post-checkout hook
mkdir -p "$REPO_ROOT/.git/hooks"
cat > "$REPO_ROOT/.git/hooks/post-checkout" << 'EOF'
#!/bin/bash
# Auto-fix executable permissions after checkout/pull
chmod 755 bin/openclaw-trader.mjs 2>/dev/null || true
EOF
chmod +x "$REPO_ROOT/.git/hooks/post-checkout"
echo "✓ Installed post-checkout hook"

# Fix current permissions
chmod 755 "$REPO_ROOT/bin/openclaw-trader.mjs" 2>/dev/null || true
echo "✓ Fixed bin/openclaw-trader.mjs permissions"

echo "✅ Setup complete!"
