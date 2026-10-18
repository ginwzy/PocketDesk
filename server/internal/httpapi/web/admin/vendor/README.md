PrismJS 1.30.0, MIT licensed; copyright notice is in `prism.LICENSE`.

`prism.min.js` is bundled locally so the Mac change reader works offline. It is
loaded only inside `change-worker.js`, not on the main UI thread. Components,
in concatenation order:

```
core clike markup css javascript typescript jsx tsx python go json bash dart swift rust yaml sql
```

To reproduce, download the pinned npm tarball with `npm pack prismjs@1.30.0`,
extract it, then concatenate `package/components/prism-<component>.min.js` in
that order, retaining the version/license banner and license file. No npm
runtime dependency or frontend build step is required.
