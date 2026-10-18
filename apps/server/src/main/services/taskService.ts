import { randomUUID } from 'node:crypto';
import { Task, type TaskDocument } from '../models/Task';
import { TaskEvent } from '../models/TaskEvent';
import { config } from '../config';
import { appendTaskEvent, abortTaskRun } from './taskProcessor';
import { redactForLog } from './logRedaction';
import { clampError } from './clampError';