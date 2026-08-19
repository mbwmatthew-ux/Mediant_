# Design references

Images the user pasted into a session, recovered as real files.

Pasted images are visible to the agent in-conversation but are **not files on
disk**, so they cannot be colour-picked, measured, cropped or diffed against a
running page. That gap is why the first pass at the home redesign guessed the
palette and got several colours meaningfully wrong — the greens were too
saturated and the "Up next" card was a real purple where the reference is a pale
mauve (#F1EAF6).

`../extract_pasted_images.py` pulls them back out of the session transcript:

```bash
python3 agent_workspace/extract_pasted_images.py            # → this folder
```

It extracts only images attached to **user** turns; images arriving as
tool_result blocks are the agent's own screenshots and are skipped. Even so it
over-collects, because screenshots the agent reads back re-enter the transcript
as user turns — expect to keep one or two files and delete the rest.

Once a reference is on disk, sample it rather than eyeballing it:

```python
from PIL import Image
from collections import Counter
im = Image.open('home-redesign-2026-08.jpeg').convert('RGB')
Counter(im.crop((300,350,520,392)).getdata()).most_common(3)   # dominant colour
im.crop((288,440,768,690)).resize((960,500)).save('/tmp/zoom.png')  # inspect detail
```

## Files

- `home-redesign-2026-08.jpeg` — the home screen direction (1672×941). Source of
  truth for the palette in `src/pages/Home.module.css`.
