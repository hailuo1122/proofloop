# Recording the 30–60s demo GIF

The repo already ships:

- Animated SVG: [`demo-terminal.svg`](./demo-terminal.svg) (works in GitHub README)
- Live transcript: regenerate with `pnpm demo:story` → [`demo-transcript.txt`](./demo-transcript.txt)

## Optional real GIF (VHS)

```bash
# https://github.com/charmbracelet/vhs
vhs docs/demo.tape
```

Example `docs/demo.tape`:

```tape
Output docs/demo.gif
Set FontSize 16
Set Width 1200
Set Height 600
Set TypingSpeed 40ms
Type "pnpm demo:story"
Enter
Sleep 45s
```

Replace the README SVG with `docs/demo.gif` when you have a recorded file.
