import urllib.request, json, os

repo = "codeswithroh/mergepay"
base = f"https://raw.githubusercontent.com/{repo}/main"

# Get tree
resp = urllib.request.urlopen(f"https://api.github.com/repos/{repo}/git/trees/main?recursive=1")
data = json.loads(resp.read())
files = [item['path'] for item in data['tree'] if item['type'] == 'blob']

for f in files:
    try:
        r = urllib.request.urlopen(f"{base}/{f}")
        content = r.read().decode('utf-8', errors='replace')
        os.makedirs(f"/tmp/mergepay/{os.path.dirname(f)}", exist_ok=True)
        with open(f"/tmp/mergepay/{f}", 'w') as out:
            out.write(content)
        print(f"  OK: {f}")
    except Exception as e:
        print(f"  ERR: {f} - {e}")
