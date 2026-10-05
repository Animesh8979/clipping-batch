import { Composition, getInputProps } from 'remotion';
import { MainComposition } from './MainComposition';

export const RemotionRoot: React.FC = () => {
  const props = getInputProps();
  
  const width = props.width || 1080;
  const height = props.height || 1920;
  const fps = props.fps || 30;
  const durationInFrames = props.durationInFrames || 300;

  return (
    <>
      <Composition
        id="BrainrotTimeline"
        component={MainComposition}
        durationInFrames={durationInFrames}
        fps={fps}
        width={width}
        height={height}
        defaultProps={{
          aroll: props.aroll || '',
          audio: props.audio || '',
          broll: props.broll || '',
          captions: props.captions || [],
        }}
      />
    </>
  );
};
