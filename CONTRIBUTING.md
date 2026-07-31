# Contributing to spicetify-connect-api

I am always happy to receive contributions to **spicetify-connect-api**! Here is how you can get started:

---

## 🚀 How to Contribute

1. **Fork** this repository on GitHub.
2. **Clone** your fork locally and create a new branch for your changes (e.g., `feature/my-feature` or `fix/my-fix`).
3. **Make your changes** in `spicetify-connect-api.js`. Please format your commit messages according to the [Conventional Commits](https://www.conventionalcommits.org/) specification.
4. **Test your changes** locally in Spotify (see instructions below).
5. **Create a Pull Request** against the `main` branch.

---

## 🧪 Local Testing

To test your changes directly inside the Spotify Desktop client:

1. Copy or symlink `spicetify-connect-api.js` into your local Spicetify `Extensions` folder:
   - **Windows:** `%appdata%\spicetify\Extensions\`
   - **Linux / macOS:** `~/.config/spicetify/Extensions/`
2. Enable and apply the extension via terminal:
   ```bash
   spicetify config extensions spicetify-connect-api.js
   spicetify apply
   ```
3. Open Spotify and inspect the Developer Console to check for logs, errors, or WebSocket connection events. Enable devtools with ``spicetify enable-devtools`` and right click in Spotify and select ``Show DevTools`` and click on the ``Console`` tab.

---

## 💡 Other Resources

* Feel free to open a [Bug Report or Feature Request](https://github.com/tobfd/spicetify-connect-api/issues) on GitHub.
* Please ensure all interactions follow our [Code of Conduct](https://github.com/tobfd/spicetify-connect-api?tab=coc-ov-file).
