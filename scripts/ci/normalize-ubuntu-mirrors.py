from pathlib import Path
import re

cloud_uri = rb"https?://(?:azure|[a-z0-9-]+\.ec2)\.archive\.ubuntu\.com/ubuntu/?(?=\s|$)"
uri = re.compile(rb"(?<!\S)" + cloud_uri)
legacy = re.compile(rb"^([ \t]*deb(?:-src)?[ \t]+(?:\[[^\]\r\n]*\][ \t]+)?)" + cloud_uri)
mirror = re.compile(rb"^([ \t]*)" + cloud_uri)
canonical = b"https://archive.ubuntu.com/ubuntu"
source_parts = Path("/etc/apt/sources.list.d")
paths = [Path("/etc/apt/apt-mirrors.txt"), Path("/etc/apt/sources.list"), *sorted(source_parts.glob("*.list")), *sorted(source_parts.glob("*.sources"))]
for path in paths:
    if not path.exists():
        continue
    original = path.read_bytes()
    lines = []
    in_uris = False
    for line in original.splitlines(keepends=True):
        if path.name == "apt-mirrors.txt":
            line = mirror.sub(rb"\g<1>" + canonical + b"/", line)
        elif path.suffix == ".sources":
            if not line.startswith((b" ", b"\t")):
                in_uris = line.startswith(b"URIs:")
            if in_uris:
                line = uri.sub(canonical, line)
        else:
            line = legacy.sub(rb"\g<1>" + canonical, line)
        lines.append(line)
    normalized = b"".join(lines)
    if normalized != original:
        path.write_bytes(normalized)
        print(f"Normalized Ubuntu cloud archive in {path}")
    else:
        print(f"Inspected APT source {path}: unchanged")
