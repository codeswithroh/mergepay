#!/bin/bash
cd /tmp
rm -rf mergepay 2>/dev/null
git clone https://github.com/codeswithroh/mergepay 2>/dev/null
find /tmp/mergepay -type f | head -100
