export async function runVoiceCommand(): Promise<void> {
  process.stderr.write(
    "step voice: voice features are disabled in this build (the CLI bundle excludes the realtime runtime).\n",
  );
  process.exit(2);
}
