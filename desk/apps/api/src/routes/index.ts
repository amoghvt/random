import type { RouteModule } from '../app';
import { register as admin } from './admin';
import { register as ask } from './ask';
import { register as auth } from './auth';
import { register as catalysts } from './catalysts';
import { register as charts } from './charts';
import { register as health } from './health';
import { register as hooks } from './hooks';
import { register as importCsv } from './import';
import { register as journal } from './journal';
import { register as notifications } from './notifications';
import { register as now } from './now';
import { register as positions } from './positions';
import { register as profile } from './profile';
import { register as push } from './push';
import { register as stream } from './stream';
import { register as tickets } from './tickets';

/** Every route module the app mounts. Add a module here to add its routes. */
export const routes: RouteModule[] = [
  health, auth, push, notifications, profile, admin, hooks, importCsv, stream,
  now, catalysts, positions, tickets, journal, ask, charts,
];
