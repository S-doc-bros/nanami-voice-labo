#!/bin/zsh
set -e

cd "$(dirname "$0")"

echo "NANAMI VOICE LABO UI"
echo "URL: http://localhost:5190"
echo
echo "Press Control-C to stop."
echo

python3 -m http.server 5190
