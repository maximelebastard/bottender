import Context from './context/Context';
import { Action, Client, Event, Props } from './types';

function withProps<C extends Client = any, E extends Event = any>(
  action: Action<C, E>,
  props: Props<C, E>
): Action<C, E> {
  // TODO: we may only apply this on dev env
  Object.freeze(props);

  const actionWithProps = (context: Context<C, E>): Action<C, E> => {
    return action.bind(null, context, props);
  };

  Object.defineProperty(actionWithProps, 'name', {
    value: `withProps(${action.name || 'Anonymous'})`,
  });

  return actionWithProps;
}

export default withProps;
