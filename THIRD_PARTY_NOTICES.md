# Third-party notices

## Theme palette snapshot

`literate/themes.literate` (the source for `src/themes.ts`) includes the 70
built-in palette names and selected RGB values from HErmonica's
`instrumentation/src/ui/theme_store.zig` and `instrumentation/src/ui/draw.zig`.
The snapshot was read from `/home/jesterking/dev/HErmonica` on 2026-09-23.
These file SHA-256 fingerprints identify the exact local source contents, not
an asserted upstream release or clean Git commit:

- `theme_store.zig`: `b32d7ce1eed5229fa408dfa0df14be435719bdef207b650da55d2f73b4d5b107`
- `draw.zig`: `9297ec52dff6ba963fb92291f9e058d36393402781e5b1a0ec6d3a5d2903d159`

The `hermonica` palette comes from HErmonica's drawing defaults. The other 69
palettes are attributed by that snapshot to
[NvChad/base46 v2.5, lua/base46/themes](https://github.com/NvChad/base46/tree/v2.5/lua/base46/themes).
Canonical names are retained, including `pasteldark` whose source file is
`pastelDark.lua`. Literate maps Base46 fields to its smaller semantic color
interface; it does not include HErmonica's storage implementation or the whole
Base46 theme engine. The mapping and the derivation of `dark` are documented in
the literate chapter. The snapshot is not claimed to match current upstream
palette files, nor to be a new download of the v3.0 palettes.

The intermediate Zig attribution string incorrectly labels Base46 as GPL-3.0.
The actual upstream [v2.5 LICENSE](https://github.com/NvChad/base46/blob/v2.5/LICENSE)
and [v3.0 LICENSE](https://github.com/NvChad/base46/blob/v3.0/LICENSE), verified
2026-09-23, both contain the MIT notice below, identifying nvim-base16.lua and
Copyright © 2019 Ashkan Kiani. The erroneous GPL label is not propagated as
Literate's license claim. Attribution for HErmonica's own defaults is separate
from that upstream notice.

All palette data is embedded locally. There is no external repository, network,
font download, or theme service dependency at runtime or during normal builds.

### Upstream MIT notice (full text)

```text
nvim-base16.lua is a library for modifying themes with Lua
Copyright © 2019 Ashkan Kiani

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
