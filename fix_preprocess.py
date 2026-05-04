import re

f = 'e:/Ai_content/Ai_content/AI_content_Mew_social/src/app/(dashboard)/short-video/page.tsx'
content = open(f, 'rb').read()

old_pattern = rb'  function preprocessScript\(raw: string\): string \{.*?  \}'

new_func = b"""  function preprocessScript(raw: string): string {
    const s = raw
      .replace(/\\r?\\n/g, " ")
      .replace(/\\([A-Za-z][^)]{0,80}\\)/g, "")
      .replace(/\\.{3,}/g, "\\n")
      .split("\\n")
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .join("\\n")
      .trim();
  }"""

result = re.sub(old_pattern, new_func, content, flags=re.DOTALL)
if result == content:
    print('NO MATCH')
else:
    open(f, 'wb').write(result)
    print('Done')
    m = re.search(rb'function preprocessScript.*?  \}', result, re.DOTALL)
    if m:
        print(m.group().decode('utf-8'))
