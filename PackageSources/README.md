# Skyward EFB

### Optional
  Open the `SkywardEfbApp.code-workspace` file inside of the SkywardEfbApp\ folder with Visual Studio Code.


______________
### Install

You should have node JS `(> v18.0)` and NPM `(> v5.0)`

**Run this command in `efb_api\` and `SkywardEfbApp\` folders:**
```bash
$ npm install
```

______________
### Build

Run this command in SkywardEfbApp\ folder to build the app once:
```bash
$ npm run build
```
______________
### Watch

Run this command in SkywardEfbApp\ folder to build the app each time you make a modification:
```bash
$ npm run watch
```
______________
### Environment variables

You can edit your environment variables in `SkywardEfbApp\.env`

| Name | Description | Should be used in | Defaults to |
| ----------- | ----------- | ----------- | ----------- |
| TYPECHECKING | Whether or not to typecheck files on build | development | true
| SOURCE_MAPS | Source maps are useful when debugging because it links the output files to the source files. | development | true
| MINIFY | Minify abstracts variables names and make code ligther. | production | false
