import util from 'util';

const levelLabels = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG'
} as const;

function format(...args: Array<unknown>) {
  return args
    .map((value) =>
      typeof value === 'string'
        ? value
        : util.inspect(value, {
            depth: 3,
            colors: false,
            breakLength: 120
          })
    )
    .join(' ');
}

export function info(...args: Array<unknown>) {
  console.log(`[${levelLabels.info}]`, format(...args));
}

export function warn(...args: Array<unknown>) {
  console.warn(`[${levelLabels.warn}]`, format(...args));
}

export function error(...args: Array<unknown>) {
  console.error(`[${levelLabels.error}]`, format(...args));
}

export function debug(...args: Array<unknown>) {
  if (process.env.DEBUG_NETWORK === 'true') {
    console.debug(`[${levelLabels.debug}]`, format(...args));
  }
}
