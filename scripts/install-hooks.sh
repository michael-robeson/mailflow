#!/bin/sh
set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"
existing=$(git config --get core.hooksPath || :)
if [ -n "$existing" ] && [ "$existing" != ".githooks" ]; then
  echo "Refusing to overwrite existing core.hooksPath: $existing" >&2
  exit 1
fi
git config --local core.hooksPath .githooks
echo "Installed local hooks from .githooks."
