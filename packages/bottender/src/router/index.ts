import Context from '../context/Context';
import { Action, Client, Event, Props } from '../types';

type MatchPattern = string | Array<string> | RegExp;

type RoutePattern<C extends Client, E extends Event> =
  | '*'
  | RoutePredicate<C, E>;

type RoutePredicate<C extends Client, E extends Event> = (
  context: Context<C, E>
) => boolean | Promise<boolean>;

type Route<C extends Client, E extends Event> = {
  predicate: RoutePredicate<C, E>;
  action: Action<C, E>;
};

function router<C extends Client = any, E extends Event = any>(
  routes: Route<C, E>[]
) {
  return async function Router(
    context: Context<C, E>,
    { next }: Props<C, E> = {}
  ) {
    for (const r of routes) {
      // eslint-disable-next-line no-await-in-loop
      if (await r.predicate(context)) {
        return r.action;
      }
    }

    return next;
  };
}

function route<C extends Client = any, E extends Event = any>(
  pattern: RoutePattern<C, E>,
  action: Action<C, E>
) {
  if (pattern === '*') {
    return {
      predicate: () => true,
      action,
    };
  }

  return {
    predicate: pattern,
    action,
  };
}

function text<C extends Client = any, E extends Event = any>(
  pattern: MatchPattern,
  action: Action<C, E>
) {
  if (typeof pattern === 'string') {
    if (pattern === '*') {
      return {
        predicate: (context: Context<C, E>) => context.event.isText,
        action,
      };
    }

    return {
      predicate: (context: Context<C, E>) => context.event.text === pattern,
      action,
    };
  }

  if (pattern instanceof RegExp) {
    return {
      predicate: (context: Context<C, E>) => pattern.test(context.event.text),
      action,
    };
  }

  if (Array.isArray(pattern)) {
    return {
      predicate: (context: Context<C, E>) =>
        pattern.includes(context.event.text),
      action,
    };
  }

  return {
    predicate: () => false,
    action,
  };
}

function payload<C extends Client = any, E extends Event = any>(
  pattern: MatchPattern,
  action: Action<C, E>
) {
  if (typeof pattern === 'string') {
    if (pattern === '*') {
      return {
        predicate: (context: Context<C, E>) => context.event.isPayload,
        action,
      };
    }

    return {
      predicate: (context: Context<C, E>) => context.event.payload === pattern,
      action,
    };
  }

  if (pattern instanceof RegExp) {
    return {
      predicate: (context: Context<C, E>) =>
        pattern.test(context.event.payload),
      action,
    };
  }

  if (Array.isArray(pattern)) {
    return {
      predicate: (context: Context<C, E>) =>
        pattern.includes(context.event.payload),
      action,
    };
  }

  return {
    predicate: () => false,
    action,
  };
}

export default router;

export { router, route, text, payload };
