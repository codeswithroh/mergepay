import urllib.request, json
resp = urllib.request.urlopen('https://api.github.com/repos/codeswithroh/mergepay/git/trees/main?recursive=1')
data = json.loads(resp.read())
for item in data['tree']:
    if item['type'] == 'blob':
        print(item['path'])
