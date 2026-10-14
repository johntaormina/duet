# Duet for VS Code

Two-layer code review. Duet explains a change, shows the choices it made and what it chose against, and puts the few decisions that need a human in front of you. For high-stakes decisions you commit to your own answer before you see Claude's. In the background, Claude hunts bugs and security issues and verifies its own findings.

## Use

- **Duet: Start review**: review the current branch, your working tree, or a pull request.
- **Duet: Open review**: reopen an earlier review.
- **Duet: Post decision log**: post your decisions to the pull request, after you approve the exact text.

Requires the Claude CLI (`claude`) and Node.js on your PATH, and `gh` for pull requests.
