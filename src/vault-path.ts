const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;
const WINDOWS_RESERVED_CHARACTER = /[<>:"|?*]/;

function hasAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function unsafeComponent(component: string): boolean {
  if (component.length === 0 || component === '.') {
    return false;
  }
  if (
    hasAsciiControlCharacter(component)
    || WINDOWS_RESERVED_CHARACTER.test(component)
    || /[. ]$/.test(component)
  ) {
    return true;
  }

  const deviceBase = component.split('.', 1)[0].replace(/[ .]+$/g, '');
  return WINDOWS_DEVICE_NAME.test(deviceBase);
}

export function normalizeSafeVaultPath(value: string): string | null {
  const candidate = value.replace(/\\/g, '/');
  if (
    candidate.length === 0
    || candidate.startsWith('/')
    || /^[A-Za-z]:/.test(candidate)
  ) {
    return null;
  }

  const rawParts = candidate.split('/');
  if (rawParts.some((part) => part === '..' || unsafeComponent(part))) {
    return null;
  }

  const parts = rawParts.filter((part) => part.length > 0 && part !== '.');
  if (parts.length === 0 || parts[0].toLowerCase() === '.obsidian') {
    return null;
  }

  return parts.join('/');
}
