import {runDeployment} from './runtime-deploy.mjs';
import {openManagedScope} from './runtime-managed-scope.mjs';

let scope;
try {
  const [descriptor, ...argv] = process.argv.slice(2);
  if (!/^(?:[3-9]|[1-9][0-9]+)$/.test(descriptor ?? '')) throw new Error();
  scope = openManagedScope({profileFd: Number(descriptor)});
  const result = await runDeployment({
    repositoryRoot: scope.repositoryRoot, home: scope.home, argv, managedScope: scope,
  });
  process.stdout.write(JSON.stringify(result)+'\n');
} catch (error) {
  const code = typeof error.code === 'string' && /^DEPLOY_[A-Z_]{1,55}$/.test(error.code)
    ? error.code : 'DEPLOY_MANAGED_MODE_REQUIRED';
  process.stdout.write(JSON.stringify({error:{code,...(error.reason?{reason:error.reason}:{})}})+'\n');
  process.exitCode = 1;
} finally {
  scope?.close();
}
