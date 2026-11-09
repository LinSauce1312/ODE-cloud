import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.ODE_CLOUD_HOME || path.join(os.homedir(), '.ode-cloud'));
