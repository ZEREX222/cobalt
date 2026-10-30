from pathlib import Path
import re

pattern = re.compile(
    r'import\s+(\w+)\s+from\s+["\']@tabler/icons-svelte/[^"\']+\.svelte["\'];?'
)

count = 0

for path in Path("src").rglob("*.svelte"):
    original = path.read_text()

    updated = pattern.sub(
        lambda m: f'import {{ {m.group(1)} }} from "@tabler/icons-svelte";',
        original
    )

    if updated != original:
        path.write_text(updated)
        count += 1

print(f"Updated {count} files")
