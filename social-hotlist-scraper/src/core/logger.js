function formatTime(value) {
  return new Date(value).toISOString();
}

export function createLogger(scope) {
  function write(level, message, extra) {
    const prefix = `[${formatTime(Date.now())}] [${scope}] [${level}]`;
    if (extra !== undefined) {
      console.log(prefix, message, extra);
      return;
    }
    console.log(prefix, message);
  }

  return {
    info(message, extra) {
      write("INFO", message, extra);
    },
    warn(message, extra) {
      write("WARN", message, extra);
    },
    error(message, extra) {
      write("ERROR", message, extra);
    }
  };
}
