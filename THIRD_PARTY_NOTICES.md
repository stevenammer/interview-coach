# Third-party notices

The MIT license at the repository root covers this project's original code. Vendored and bundled third-party code and fonts retain their upstream licenses. No employer or provider endorsement is implied.

| Package | Version | Upstream declaration | License notices |
| --- | --- | --- | --- |
| @pdf-lib/fontkit | 1.1.1 | MIT | [Package declaration; no separate license file supplied](https://github.com/Hopding/fontkit) |
| @pdf-lib/standard-fonts | 1.0.0 | MIT | [LICENSE.md](public/vendor/licenses/pdf-lib-standard-fonts-LICENSE.md) |
| @pdf-lib/upng | 1.0.1 | MIT | [LICENSE](public/vendor/licenses/pdf-lib-upng-LICENSE) |
| docx | 9.9.0 | MIT | [LICENSE](public/vendor/licenses/docx-LICENSE) |
| pako | 1.0.11 | (MIT AND Zlib) | [LICENSE](public/vendor/licenses/pako-LICENSE) |
| pdf-lib | 1.17.1 | MIT | [LICENSE.md](public/vendor/licenses/pdf-lib-LICENSE.md) |
| tslib | 2.8.1 | 0BSD | [LICENSE.txt](public/vendor/licenses/tslib-LICENSE.txt), [CopyrightNotice.txt](public/vendor/licenses/tslib-CopyrightNotice.txt) |
| eventemitter3 | 5.0.4 | MIT | [LICENSE](public/vendor/licenses/eventemitter3-LICENSE) |
| livekit-client | 2.23.0 | Apache-2.0 | [LICENSE](public/vendor/licenses/livekit-client-LICENSE) |
| retell-client-js-sdk | 3.0.2 | ISC | [Package declaration; no separate license file supplied](https://github.com/RetellAI/retell-client-js-sdk) |
| fflate | 0.8.3 | MIT | [LICENSE](public/vendor/licenses/fflate-LICENSE) |
| mammoth | 1.13.0 | BSD-2-Clause | [LICENSE](public/vendor/licenses/mammoth-LICENSE) |
| pdfjs-dist | 5.5.207 | Apache-2.0 | [LICENSE](public/vendor/licenses/pdfjs-dist-LICENSE) |
| jszip | 3.10.2 | (MIT OR GPL-3.0-or-later) | [LICENSE.markdown](public/vendor/licenses/jszip-LICENSE.markdown) |

The Retell SDK and PDF-lib fontkit packages declare ISC and MIT respectively but ship no separate license file in the reviewed package versions. Their upstream repository links are included above; this inventory does not invent missing copyright notices or claim a separate legal review.

Noto font files use the [SIL Open Font License](public/vendor/NotoSans-OFL.txt). Existing PDF.js and Mammoth notices remain alongside the vendored files.

The document-export bundle includes upstream prebundled code (including JSZip, pako, browser Buffer and ieee754). Preserve its embedded legal comments when rebuilding. The package inventory is derived from actual build inputs and upstream package metadata; it is not a line-by-line audit of third-party internals.

Rebuild the first-party entry bundles with `npm run build:imports`, `npm run build:documents`, and `node scripts/build-retell.mjs`. Use `npm ci` with the lockfile. PDF.js and Mammoth copies were verified byte for byte against their installed locked package distributions.
