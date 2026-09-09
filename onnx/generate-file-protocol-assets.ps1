# Regenerates onnx/file-protocol-assets.js — see the big comment at that
# file's own top for what it's for and how it's used. Run this again
# (from any location — paths below are relative to this script's own
# folder) whenever the model or the vendored onnxruntime-web files
# change, so the file:// fallback stays in sync with the real ones.
#
#   powershell -File onnx\generate-file-protocol-assets.ps1

$onnxDir = $PSScriptRoot
$root = Split-Path $onnxDir -Parent
$mjsPath = "$onnxDir\ort-wasm-simd-threaded.mjs"
$wasmPath = "$onnxDir\ort-wasm-simd-threaded.wasm"
$modelPath = "$root\models\manga_panel_detector_fp32_1024.onnx"
$outPath = "$onnxDir\file-protocol-assets.js"

Write-Host "Reading mjs source..."
$mjsText = [System.IO.File]::ReadAllText($mjsPath)

# Patches around a real gap in onnxruntime-web: the glue code's default
# wasm-file locator unconditionally builds `new URL(file, import.meta.url)`
# as a fallback, even when wasmBinary is supplied and that fallback is
# never actually used for fetching - ort.min.js's own orchestration only
# adds a locateFile callback (which would skip this) when wasmBinary is
# NOT given, so there's no supported way to avoid this from outside the
# file. It's harmless when the module loads from a real http(s)/file URL,
# but throws when it loads from a blob: URL (our file:// fallback's own
# mechanism for dodging the "import() of a local file" restriction),
# since blob: URLs can't be used as a relative-resolution base. Since
# wasmBinary makes the computed value unused anyway, replacing it with the
# bare filename removes the throw without changing behavior.
$badPattern = '(new URL("ort-wasm-simd-threaded.wasm",import.meta.url)).href'
$patchedCount = ([regex]::Matches($mjsText, [regex]::Escape($badPattern))).Count
if ($patchedCount -ne 1) {
    throw "Expected exactly 1 occurrence of the pattern to patch, found $patchedCount - the vendored .mjs file may have changed; re-check before proceeding."
}
$mjsText = $mjsText.Replace($badPattern, '"ort-wasm-simd-threaded.wasm"')
Write-Host "Patched the import.meta.url fallback ($patchedCount occurrence)."

# JSON string escaping is a strict, safe subset of JS string escaping - use
# it to safely embed arbitrary source text as a JS string literal without
# hand-rolling escape logic.
Add-Type -AssemblyName System.Web.Extensions
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$serializer.MaxJsonLength = [int]::MaxValue
$mjsJson = $serializer.Serialize($mjsText)

Write-Host "Reading + base64-encoding wasm binary ($((Get-Item $wasmPath).Length) bytes)..."
$wasmBytes = [System.IO.File]::ReadAllBytes($wasmPath)
$wasmBase64 = [Convert]::ToBase64String($wasmBytes)

Write-Host "Reading + base64-encoding model ($((Get-Item $modelPath).Length) bytes)..."
$modelBytes = [System.IO.File]::ReadAllBytes($modelPath)
$modelBase64 = [Convert]::ToBase64String($modelBytes)

Write-Host "Writing output file..."
$writer = New-Object System.IO.StreamWriter($outPath, $false, [System.Text.Encoding]::UTF8)
$writer.WriteLine("// ============================================================================")
$writer.WriteLine("// GENERATED FILE - do not hand-edit. Regenerate with generate-file-protocol-")
$writer.WriteLine("// assets.ps1 in this same folder.")
$writer.WriteLine("// ============================================================================")
$writer.WriteLine("// Everything ONNX Runtime Web and the panel-detection model need, embedded")
$writer.WriteLine("// directly as JS string data instead of separate files fetched by URL. This")
$writer.WriteLine("// exists purely for the file:// case: opening index.html directly (no server)")
$writer.WriteLine("// blocks fetch() and dynamic import() of local files entirely, which is how")
$writer.WriteLine("// ort.min.js normally loads its WASM runtime and how the app normally loads")
$writer.WriteLine("// the model - see getPanelSession() in index.html for where this is actually")
$writer.WriteLine("// used (only when location.protocol is file:, so http(s) users never pay the")
$writer.WriteLine("// cost of loading this file at all).")
$writer.WriteLine("//")
$writer.WriteLine("// mjsSource: the full text of onnx/ort-wasm-simd-threaded.mjs (with one small")
$writer.WriteLine("// patch - see this file's generator script), the small JS wrapper ort.min.js")
$writer.WriteLine("// normally loads via a dynamic import() of that file by URL - blocked on")
$writer.WriteLine("// file://. getPanelSession() instead wraps this SOURCE TEXT in a Blob and")
$writer.WriteLine("// imports the resulting blob: URL, which isn't subject to the same restriction.")
$writer.WriteLine("//")
$writer.WriteLine("// wasmBase64 / modelBase64: onnx/ort-wasm-simd-threaded.wasm and")
$writer.WriteLine("// models/manga_panel_detector_fp32_1024.onnx, base64-encoded so they can be")
$writer.WriteLine("// embedded as plain JS string literals. Decoded back to raw bytes at runtime")
$writer.WriteLine("// and handed to onnxruntime-web directly (ort.env.wasm.wasmBinary, and")
$writer.WriteLine("// ort.InferenceSession.create(bytes, ...)) instead of a URL for it to fetch.")
$writer.WriteLine("// ============================================================================")
$writer.Write("window.__ortFileProtocolAssets = {`n  mjsSource: ")
$writer.Write($mjsJson)
$writer.Write(",`n  wasmBase64: `"")
$writer.Write($wasmBase64)
$writer.Write("`",`n  modelBase64: `"")
$writer.Write($modelBase64)
$writer.Write("`"`n};`n")
$writer.Close()

$outSize = (Get-Item $outPath).Length
Write-Host "Done. Output file size: $([math]::Round($outSize/1MB, 2)) MB"
