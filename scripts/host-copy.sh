#!/bin/bash
# Host Copy Script for local-search-mcp
# Copies necessary host files to a secure cache directory for Docker packaging

set -e

CACHE_DIR="${HOST_CACHE_DIR:-$HOME/.cache/local-search-mcp}"
MOUNT_DIR="$(pwd)/host-cache"

usage() {
  echo "Usage: $0 <command>"
  echo "Commands:"
  echo "  check       - Check what would be copied"
  echo "  copy        - Copy files to cache directory (requires confirmation)"
  echo "  mount       - Show docker volume mount configuration"
  echo "  clean       - Remove cached files"
  echo ""
  echo "Cache directory: $CACHE_DIR"
  echo "Mount directory: $MOUNT_DIR"
}

check_opencli() {
  if command -v opencli &> /dev/null; then
    echo "✓ opencli found: $(which opencli)"
    opencli --version 2>/dev/null || true
    return 0
  else
    echo "✗ opencli not found"
    return 1
  fi
}

check_cache() {
  echo "=== Cache Status ==="
  if [ -d "$CACHE_DIR" ]; then
    echo "Cache directory exists: $CACHE_DIR"
    echo "Contents:"
    ls -la "$CACHE_DIR" 2>/dev/null || echo "  (empty)"
  else
    echo "Cache directory does not exist: $CACHE_DIR"
  fi
}

copy_opencli() {
  echo "=== Copying opencli cache ==="
  
  if [ ! -d "$HOME/.opencli" ]; then
    echo "No opencli config found at ~/.opencli"
    return 1
  fi

  mkdir -p "$CACHE_DIR/opencli"
  
  echo "Copying ~/.opencli to $CACHE_DIR/opencli..."
  cp -r "$HOME/.opencli"/* "$CACHE_DIR/opencli/" 2>/dev/null || true
  
  echo "✓ opencli cache copied to $CACHE_DIR/opencli"
  echo ""
  echo "To enable in Docker, add to docker-compose.yml:"
  echo "  volumes:"
  echo "    - $CACHE_DIR/opencli:/root/.opencli:ro"
}

show_mount() {
  echo "=== Docker Volume Mount ==="
  echo "Add to docker-compose.yml services.local-search-mcp.volumes:"
  echo "  - $CACHE_DIR/opencli:/root/.opencli:ro"
}

clean_cache() {
  echo "=== Cleaning Cache ==="
  if [ -d "$CACHE_DIR" ]; then
    read -p "Remove $CACHE_DIR? (y/N): " confirm
    if [ "$confirm" = "y" ]; then
      rm -rf "$CACHE_DIR"
      echo "✓ Cache removed"
    else
      echo "Cancelled"
    fi
  else
    echo "Nothing to clean"
  fi
}

case "${1:-}" in
  check)
    check_opencli
    check_cache
    ;;
  copy)
    check_opencli
    copy_opencli
    ;;
  mount)
    show_mount
    ;;
  clean)
    clean_cache
    ;;
  *)
    usage
    ;;
esac