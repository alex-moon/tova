export function muteConsoleError(): jest.SpyInstance {
  return jest.spyOn(console, 'error').mockImplementation(() => {});
}

export function muteConsoleWarn(): jest.SpyInstance {
  return jest.spyOn(console, 'warn').mockImplementation(() => {});
}
