const fs = require('fs');
const path = require('path');

/**
 * Load a JSON configuration file from the ./config directory and merge it with
 * provided defaults. Environment variables can override config values using
 * the pattern `${prefix}_${KEY}` where nested keys are joined with `_` and
 * uppercased. For example, `SERVER_PORT` overrides `config.port` when the
 * prefix is `SERVER`.
 *
 * @param {string} filename - Name of the JSON file inside ./config.
 * @param {object} defaults - Default values to merge with.
 * @param {string} [envPrefix] - Optional environment variable prefix.
 * @returns {object}
 */
function loadConfig(filename, defaults = {}, envPrefix) {
  const configPath = path.resolve(process.cwd(), 'config', filename);
  let fileConfig = {};

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      fileConfig = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Failed to read configuration at ${configPath}: ${error.message}`);
    }
  }

  const merged = deepMerge(defaults, fileConfig);

  if (envPrefix) {
    applyEnvOverrides(merged, envPrefix, []);
  }

  return merged;
}

function deepMerge(target, source) {
  const output = Array.isArray(target) ? [...target] : { ...target };

  Object.keys(source || {}).forEach((key) => {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = deepMerge(target[key] || {}, value);
    } else {
      output[key] = value;
    }
  });

  return output;
}

function applyEnvOverrides(config, prefix, pathStack) {
  Object.keys(config).forEach((key) => {
    const value = config[key];
    const envKey = [prefix, ...pathStack, key]
      .map((segment) => segment.toString().replace(/([a-z])([A-Z])/g, '$1_$2'))
      .join('_')
      .replace(/[-\s]/g, '_')
      .toUpperCase();

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      applyEnvOverrides(value, prefix, [...pathStack, key]);
      return;
    }

    if (process.env[envKey] !== undefined) {
      config[key] = coerceEnvType(process.env[envKey], value);
    }
  });
}

function coerceEnvType(rawValue, currentValue) {
  if (typeof currentValue === 'number') {
    const num = Number(rawValue);
    if (!Number.isFinite(num)) {
      throw new Error(`Expected numeric env override but received '${rawValue}'`);
    }
    return num;
  }

  if (typeof currentValue === 'boolean') {
    return ['true', '1', 'yes', 'on'].includes(String(rawValue).toLowerCase());
  }

  if (Array.isArray(currentValue)) {
    try {
      return JSON.parse(rawValue);
    } catch (error) {
      throw new Error(`Failed to parse array env override '${rawValue}': ${error.message}`);
    }
  }

  return rawValue;
}

module.exports = {
  loadConfig,
};



