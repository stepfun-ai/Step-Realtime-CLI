export async function runVadCommand(): Promise<void> {
  process.stderr.write(
    "step vad: voice features are disabled in this build (the CLI bundle excludes the realtime runtime).\n",
  );
  process.exit(2);
}
