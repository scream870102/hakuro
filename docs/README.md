# Hakuro introduction site

Live site: https://scream870102.github.io/hakuro/

Static Traditional Chinese product introduction for GitHub Pages. No build step or runtime dependencies. Serve this directory with a static HTTP server; all asset paths work under `/hakuro/` or a domain root.

App and website source are maintained together on `main`. The `Deploy website to GitHub Pages` workflow (`.github/workflows/pages.yml`) uploads only `docs/` when this directory or the workflow changes on `main`. It can also be run manually from Actions on `main`. GitHub Pages uses the GitHub Actions publishing source, with HTTPS enabled. The old `gh-pages` branch is no longer a publishing source.

## Authentic application media

- `assets/app-full.png` and `assets/app-compact.png`: actual unblurred application screenshots used as video posters.
- `assets/app-full-motion.mp4` and `assets/app-compact-motion.mp4`: silent application recordings, manual playback with native controls, loop, muted and playsinline. No autoplay.
- `assets/app-command-palette.png`: actual command palette capture accompanying its feature description.
- `assets/face-front.png`, `face-right.png`, `face-top.png`, `face-back.png`, `face-left.png`, `face-bottom.png`: six square textures captured from the actual app. The CSS cube is an instructional reconstruction using these captures, not a live player.
- `assets/fonts/anton-latin-400-normal.woff2` and `jetbrains-mono-latin-400-normal.woff2`: app fonts with license files. Chinese falls back to the system font.

## Interaction and accessibility

Drag the cube to rotate it; select a numbered face step to restore a useful viewing angle. Hover, focus or tap a control hotspot to update its explanation. Invisible faces are inert and their buttons excluded from keyboard navigation. Dragging does not activate a hotspot. The five guide tabs use Up/Down/Home/End; player tabs use Left/Right/Home/End. Native buttons support Enter and Space. Reduced motion disables transitions and smooth scrolling. Videos never autoplay.

The site does not control playback or call music services. Main and compact layouts differ; the interactive cube illustrates the full mode. Feature text covers source-provided translations, configurable shake actions, command search, click-through, pinning and local-audio sound waves. Source behavior is grounded in the app README/settings. Screenshots and textures use the installed app's custom pink accent; the website uses the documented yellow default. Refresh captures when the UI changes.
