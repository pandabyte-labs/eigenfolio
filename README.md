# Traeky

[![Release][release-shield]][release-url]

> Local (and self-hosted) crypto portfolio.

Traeky is a privacy-friendly, self-hostable web app to track your crypto portfolio and generate a basic report.
The UI runs entirely in your browser, data is stored locally.

---

## Features

- Track crypto holdings and transactions
- Portfolio and gain/loss overview
- Export a PDF report
- CSV import & export (Traeky-specific schema)
- Local-first: everything runs in the browser, no external API required (except coingecko price fetching) for basic usage
- English and German translations

---

## Project status

Traeky is currently in an early version (see version badge above).
APIs, data schema and UI are subject to change between releases.

---

## Docker images

Docker images are published to Docker Hub:

- `pandabytelabs/traeky:latest` – latest stable release from `main`
- `pandabytelabs/traeky:stable` – alias for the latest stable release
- `pandabytelabs/traeky:testing` – pre-release builds from `develop`
- `pandabytelabs/traeky:nightly` – nightly builds from `develop`
- `pandabytelabs/traeky:<version>` – versioned images (matching the app version shown above)

Tags:

- **Stable (main)** → `latest`, `stable`, and `:<version>`
- **Pre-release (develop)** → `testing` and `:<version>`
- **Nightly (develop)** → `nightly`

---

## Quick start with Docker (recommended)

### Run the stable image

```bash
docker run --rm -p 5173:5173 --name traeky pandabytelabs/traeky:latest
```

Now open:

```text
http://localhost:5173
```

### Run the testing (pre-release) image

```bash
docker run --rm -p 5173:5173 --name traeky-testing pandabytelabs/traeky:testing
```

### Environment variables

The app supports configuration via environment variables.

- `TRAEKY_ALLOWED_HOSTS`
  - Controls which `Host` headers the dev server will accept
  - Examples:
    - `TRAEKY_ALLOWED_HOSTS=example.com`
    - `TRAEKY_ALLOWED_HOSTS=example.net,example.com`
    - `TRAEKY_ALLOWED_HOSTS=all` (or `true` / `*`) to allow all hosts

Example with a restricted host allowlist:

```bash
docker run --rm \
  -p 5173:5173 \
  -e TRAEKY_ALLOWED_HOSTS=myTraekyDomain.tld \
  --name traeky \
  pandabytelabs/traeky:latest
```

---

## Self-hosting without Docker

You can also build and host Traeky yourself, e.g. on your own server or behind a reverse proxy.

### 1. Install dependencies

You need:

- Node.js 20+
- npm (comes with Node)

Install dependencies:

```bash
npm install
```

### 2. Development server (for local usage)

```bash
npm run dev -- --host 0.0.0.0 --port 5173
```

Then open:

```text
http://localhost:5173
```

This mode is intended for development and local testing.

### 3. Production build

Create a production build:

```bash
npm run build
```

This will generate static assets in the `dist/` directory.

You can serve `dist/` with any static file server, for example:

```bash
npm install -g serve
serve dist
```

Or configure a reverse proxy like Nginx / Caddy to serve the `dist` directory over HTTPS.

---

## Running your own Docker image (self-built)

If you prefer to build your own image instead of using the public Docker Hub images:

```bash
# Build the image
docker build -t traeky:local .

# Run it
docker run --rm -p 5173:5173 --name traeky-local traeky:local
```

You can then tag & push it to your own registry if you like.

---

## Branch and release model

- `develop`
  - Active development
  - Dependabot pull requests are opened against this branch
  - Pre-releases (GitHub pre-release) are built from `develop`
  - Docker tag: `testing` + version tag or `nightly` for nightly

- `main`
  - Stable, tested code
  - Normal (non pre-release) GitHub Releases are created from `main`
  - Docker tags: `latest`, `stable` + version tag

---

## Contributing

The project is currently focused on private, non-commercial usage.
If you want to contribute improvements, feel free to open an issue or a pull request.
Please respect the license terms below.

---

## License

This project is distributed under the **Traeky Non-Commercial License** (see `LICENSE`).

In short:

- You may use Traeky for personal, non-commercial purposes.
- You may modify the code for your private use.
- You must keep the original copyright notices.
- You may not use Traeky or derivatives for commercial purposes (including paid services or SaaS).
- You may not sell or re-license Traeky.

The full license text can be found in the `LICENSE` file in this repository.

[release-shield]: https://img.shields.io/github/v/release/pandabytelabs/Traeky.svg?style=for-the-badge
[release-url]: https://github.com/pandabytelabs/traeky/releases/latest