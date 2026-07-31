/**
 * Print the permission catalogue as Markdown.
 *
 *   npx tsx scripts/dumpPermissions.ts > PERMISSIONS.md
 *
 * The catalogue is meant to be read by whoever grants permissions, and that person should
 * not have to open a TypeScript file to do it. This exists so the same prose the Roles
 * screen renders can be reviewed, printed or circulated on its own.
 */
import { PERMISSIONS, permissionsByModule } from '../src/lib/permissions';

const RISK: Record<string, string> = {
  normal: 'Normal',
  sensitive: 'Sensitive — discloses information',
  destructive: 'Destructive — loses data or money',
};

const out: string[] = [
  '# Permission catalogue',
  '',
  `${PERMISSIONS.length} permissions across ${permissionsByModule().length} modules.`,
  '',
  'Each entry is one checkbox on Settings → Roles. **Allows** is what becomes possible;',
  '**Blocks** is the near-miss that somebody granting it would otherwise assume came with it.',
  '',
];

for (const { module, permissions } of permissionsByModule()) {
  out.push(`## ${module}`, '');
  for (const p of permissions) {
    out.push(`### ${p.label}`, '', `\`${p.key}\` · ${RISK[p.risk]}`, '', p.what, '', '**Allows**', '');
    for (const a of p.allows) out.push(`- ${a}`);
    out.push('', '**Blocks**', '');
    for (const b of p.blocks) out.push(`- ${b}`);
    if (p.requires?.length) out.push('', `**Needs first:** ${p.requires.map((r) => `\`${r}\``).join(', ')}`);
    out.push('');
  }
}

console.log(out.join('\n'));
