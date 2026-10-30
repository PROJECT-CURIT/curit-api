import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import QRCode from "qrcode"
import { seedListings } from "../seeds.js"

function argument(name: string, fallback: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]!
    : fallback
}

const baseUrl = argument("--base-url", "http://localhost:5173").replace(
  /\/$/,
  "",
)
const output = resolve(argument("--output", "generated-qr"))
await mkdir(output, { recursive: true })

for (const seed of seedListings) {
  const target = `${baseUrl}/q/${encodeURIComponent(seed.token)}`
  const svg = await QRCode.toString(target, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
    color: { dark: "#23351f", light: "#ffffff" },
  })
  await writeFile(
    resolve(
      output,
      `${seed.snapshot.product.artworkId.replace(/[^a-z0-9_-]/gi, "-")}.svg`,
    ),
    svg,
  )
  console.log(`${seed.snapshot.product.name}: ${target}`)
}
