import fs from 'node:fs';
import { openRuntimeBundle } from './runtime-entry.mjs';
import { DeploymentError } from './runtime-safety.mjs';
import { resolveSessionBindingV2 } from './runtime-store.mjs';

// The service runner enters through the ordinary v2 session wrapper. The
// client protocol never supplies this token, a release ID, or an artifact path.
export function openBoundRuntimeBundle({repositoryRoot, selector}) {
  const token = process.env.JHW_RUNTIME_SESSION_BINDING;
  if (token === undefined) throw new DeploymentError('DEPLOY_SESSION_INVALID');
  const {releaseId, bootstrapId} = resolveSessionBindingV2({repositoryRoot, token});
  const artifact = openRuntimeBundle({repositoryRoot, releaseId, selector});
  let closed = false;
  return Object.freeze({
    releaseId,
    bootstrapId,
    fd: artifact.fd,
    verify() {
      if (closed) throw new DeploymentError('DEPLOY_RELEASE_CHANGED');
      artifact.verify();
    },
    close() {
      if (closed) return;
      closed = true;
      fs.closeSync(artifact.fd);
    },
  });
}
