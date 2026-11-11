// Fails like a crashing adapter: a message on stderr, exit code 3, no output.
process.stderr.write("fixture crash: adapter exploded\n");
process.exit(3);
