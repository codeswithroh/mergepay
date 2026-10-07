#!/bin/bash
curl -s https://api.github.com/repos/codeswithroh/mergepay/git/trees/main?recursive=1 | jq -r '.tree[] | select(.type=="blob") | .path'
