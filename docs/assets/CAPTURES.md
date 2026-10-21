# App capture provenance

- Captured 2026-10-21 from the installed official Hakuro v1.6.2 Windows executable, not a mock backend or reconstructed UI.
- Official installer SHA-256: `851a8c9eaf71b7066bae43a8ef441cf581c1b357f66cadd749023044299001d1`.
- `app-full.png`: actual full-mode WebView, 940 × 760, including original and translated lyrics.
- `app-compact.png`: actual compact-mode WebView with bilingual lyrics, 662 × 424, transparent background.
- `app-command-palette.png`: actual Command Palette window after its opening animation.
- `app-full-motion.mp4`: 12.042 seconds, 940 × 760 H.264, 24 fps.
- `app-compact-motion.mp4`: 10.042 seconds, 662 × 424 H.264, 24 fps; transparent desktop is black in the video.
- Videos consist only of actual WebView screencast frames. No audio was captured; ffprobe confirms each MP4 contains exactly one video stream and no audio stream. Encoded with `-an` and `+faststart`.
- Captured through Playwright CDP against a temporary localhost-only WebView2 debug port. The app's own compact/full controls switched the layout.
- Revision 2 follows the user's explicit request to retain clear lyric text. Original/translated lyrics, current pink accent and album art are unmodified; no replacement lyrics or playback data were injected.
- `face-front/right/top/back/left/bottom.png`: real full-mode app face artwork captured at 3× scale through CDP. Capture-only CSS flattened each face, hid its siblings and exposed the existing previous/next hover buttons; square texture exports receive the app's 10% rounded corners on the website. No controls were redrawn. The webpage adds transparent explanatory hotspots.
- The website's cube is a textured instructional model, not a live player. It uses full-mode control positions; compact-mode controls differ and are shown in the actual compact recording.
- Bundled Anton and JetBrains Mono font assets are copied from the app dependencies, with their respective OFL licenses in `fonts/`.

For future captures, inspect the exported image itself. Native desktop captures of the transparent window may contain only wallpaper even when the accessibility tree is correct.
