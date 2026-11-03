## Install

**Homebrew** (macOS and Linux)

```bash
brew tap aavishay/azure-devops-board
brew trust aavishay/azure-devops-board
brew install azure-devops-board
```

Then run `azure-devops-board`. It opens the board in your default browser; press Ctrl+C in the terminal to stop it.

Coming from the desktop app? Remove it first with `brew uninstall --cask azure-devops-board`. Your settings and sign-in carry over.

**Without Homebrew:** download the archive for your system, put `azure-devops-board` on your `PATH`, and run it.
The builds are not signed. On macOS, clear the quarantine flag once: `xattr -d com.apple.quarantine azure-devops-board`.
On Windows, SmartScreen may warn the first time: choose **More info → Run anyway**.
