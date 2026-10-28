## Install

**macOS** (universal: Apple Silicon and Intel)

```bash
brew tap aavishay/azure-devops-board
brew trust aavishay/azure-devops-board
brew install --cask azure-devops-board
```

The build is not notarized. The cask clears the quarantine flag, but if you
install the `.dmg` or `.app.zip` directly, clear it once yourself:

```bash
xattr -dr com.apple.quarantine "/Applications/Azure DevOps Board.app"
```

**Windows:** run the `windows-x64-setup.exe`. It is not code-signed, so
SmartScreen may say "Windows protected your PC": choose **More info → Run anyway**.

**Linux:** download the `.AppImage`, `chmod +x` it and run it. Needs WebKitGTK 4.1.
