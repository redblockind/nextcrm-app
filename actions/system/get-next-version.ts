import packageJson from "@/package.json";

export default async function getNextVersion(): Promise<string> {
  // Read the Next.js version straight from the bundled package.json.
  // Importing it (instead of fs.readFileSync on a relative path) keeps this
  // reliable in serverless runtimes where the working directory has no
  // package.json, and guarantees a string is always returned.
  return packageJson.dependencies?.next ?? "0";
}
