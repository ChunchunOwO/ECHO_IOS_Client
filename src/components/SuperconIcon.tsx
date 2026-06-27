import React, { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import Svg, {
  Circle,
  Ellipse,
  G,
  Line,
  Path,
  Polygon,
  Polyline,
  Rect,
  type SvgProps,
} from 'react-native-svg';
import Back from 'supercons/Back';
import Checkmark from 'supercons/Checkmark';
import External from 'supercons/External';
import Headphones from 'supercons/Headphones';
import Link from 'supercons/Link';
import List from 'supercons/List';
import PauseCircle from 'supercons/PauseCircle';
import PlayCircle from 'supercons/PlayCircle';
import Settings from 'supercons/Settings';
import ViewBack from 'supercons/ViewBack';
import ViewClose from 'supercons/ViewClose';
import ViewCloseSmall from 'supercons/ViewCloseSmall';
import ViewForward from 'supercons/ViewForward';
import ViewReload from 'supercons/ViewReload';
import Waveform from 'supercons/Waveform';

const superconSources = {
  back: Back,
  checkmark: Checkmark,
  external: External,
  headphones: Headphones,
  link: Link,
  list: List,
  'pause-circle': PauseCircle,
  'play-circle': PlayCircle,
  settings: Settings,
  'view-back': ViewBack,
  'view-close': ViewClose,
  'view-close-small': ViewCloseSmall,
  'view-forward': ViewForward,
  'view-reload': ViewReload,
  waveform: Waveform,
} as const;

const nativeSvgElements = {
  circle: Circle,
  ellipse: Ellipse,
  g: G,
  line: Line,
  path: Path,
  polygon: Polygon,
  polyline: Polyline,
  rect: Rect,
} as const;

const nativePropNames = [
  'clipPath',
  'clipRule',
  'cx',
  'cy',
  'd',
  'fill',
  'fillOpacity',
  'fillRule',
  'height',
  'opacity',
  'points',
  'preserveAspectRatio',
  'r',
  'rx',
  'ry',
  'stroke',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeMiterlimit',
  'strokeOpacity',
  'strokeWidth',
  'transform',
  'viewBox',
  'width',
  'x',
  'x1',
  'x2',
  'y',
  'y1',
  'y2',
] as const;

type SuperconSource = {
  render: (props: { size?: number }, ref: unknown) => ReactElement;
};

export type SuperconGlyph = keyof typeof superconSources;

type SuperconIconProps = Omit<SvgProps, 'children' | 'color' | 'height' | 'viewBox' | 'width'> & {
  color?: string;
  glyph: SuperconGlyph;
  size?: number;
};

const pickNativeProps = (props: Record<string, unknown>): Record<string, unknown> => {
  const nativeProps: Record<string, unknown> = {};

  for (const propName of nativePropNames) {
    if (props[propName] !== undefined) {
      nativeProps[propName] = props[propName];
    }
  }

  return nativeProps;
};

const renderNativeSvgNode = (node: ReactNode, keyPrefix = 'supercon'): ReactNode => (
  Children.map(node, (child, index) => {
    if (!isValidElement(child)) {
      return null;
    }

    const childProps = child.props as { children?: ReactNode } & Record<string, unknown>;

    if (child.type === React.Fragment) {
      return renderNativeSvgNode(childProps.children, `${keyPrefix}-${index}`);
    }

    if (typeof child.type !== 'string') {
      return null;
    }

    const NativeElement = nativeSvgElements[child.type as keyof typeof nativeSvgElements] as React.ElementType | undefined;
    if (!NativeElement) {
      return null;
    }

    return React.createElement(
      NativeElement,
      {
        key: `${keyPrefix}-${index}`,
        ...pickNativeProps(childProps),
      },
      renderNativeSvgNode(childProps.children, `${keyPrefix}-${index}`),
    );
  })
);

export const SuperconIcon = ({
  color = '#f8fafc',
  glyph,
  size = 24,
  ...svgProps
}: SuperconIconProps): ReactElement => {
  const SuperconSourceIcon = superconSources[glyph] as unknown as SuperconSource;
  const sourceIcon = SuperconSourceIcon.render({ size }, null);
  const sourceProps = sourceIcon.props as { children?: ReactNode; viewBox?: string } & Record<string, unknown>;

  return (
    <Svg
      {...pickNativeProps(sourceProps)}
      {...svgProps}
      color={color}
      fill={color}
      height={size}
      viewBox={sourceProps.viewBox ?? '0 0 32 32'}
      width={size}
    >
      {renderNativeSvgNode(sourceProps.children)}
    </Svg>
  );
};
