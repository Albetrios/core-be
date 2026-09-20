import type { RouteAccess } from './types.js';

export function extractRouteSnippet(content: string, methodIndex: number): string {
  const rest = content.slice(methodIndex);
  const nextRouteMatch = rest
    .slice(1)
    .match(/\n\s*[a-zA-Z][\w$]*\.(get|post|patch|put|delete)\s*[(<]/);
  const endIndex =
    nextRouteMatch?.index !== undefined ? nextRouteMatch.index + 1 : Math.min(rest.length, 500);
  return rest.slice(0, endIndex);
}

export function classifyAccess(snippet: string, permissionMap: Map<string, string>): RouteAccess {
  if (snippet.includes("'/logout'") || snippet.includes('"/logout"')) {
    return 'TOKEN: access-token';
  }

  // `/refresh` carries no `app.authenticate` (the access token is expired by definition when a
  // client refreshes), but it is NOT public: the handler requires a valid `session_id` httpOnly
  // cookie and enforces the CSRF Origin/Referer allowlist. Cataloguing it PUBLIC misread the
  // route as unauthenticated.
  if (snippet.includes("'/refresh'") || snippet.includes('"/refresh"')) {
    return 'TOKEN: session-cookie';
  }

  if (!snippet.includes('app.authenticate')) {
    return 'PUBLIC';
  }

  if (snippet.includes('requireRole')) {
    const roles: string[] = [];
    if (snippet.includes('GLOBAL_ROLES.SUPER_ADMIN') || snippet.includes("'super_admin'")) {
      roles.push('super_admin');
    }
    if (snippet.includes('GLOBAL_ROLES.USER') || snippet.includes("'user'")) {
      roles.push('user');
    }
    const uniqueRoles = [...new Set(roles)];
    return `ROLE: ${uniqueRoles.join(', ')}`;
  }

  const permissionMatch = snippet.match(/requireOrganizationPermission\(\s*([\w.]+\.[\w]+)/);
  if (permissionMatch?.[1]) {
    const code = permissionMap.get(permissionMatch[1]) ?? permissionMatch[1];
    return `PERM: ${code}`;
  }

  return 'AUTH';
}
