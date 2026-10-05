import { AbsoluteFill, Audio, Video, staticFile } from 'remotion';
import { BouncySubtitle } from '../BouncySubtitle';

interface MainCompositionProps {
  aroll: string;
  audio: string;
  broll?: string;
  captions: any[];
}

export const MainComposition: React.FC<MainCompositionProps> = ({ aroll, audio, broll, captions }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      
      {/* Top Half: Visual A-roll Layer */}
      {aroll && (
        <AbsoluteFill style={{ height: '50%', overflow: 'hidden' }}>
          <Video
            src={staticFile(aroll)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        </AbsoluteFill>
      )}

      {/* Bottom Half: B-roll Layer (Subway Surfers etc) */}
      {broll && (
        <AbsoluteFill style={{ height: '50%', top: '50%', overflow: 'hidden' }}>
          <Video
            src={staticFile(broll)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
            muted // we don't want Subway Surfers audio mixing in
          />
        </AbsoluteFill>
      )}

      {/* High-Quality Audio Layer */}
      {audio && <Audio src={staticFile(audio)} />}

      {/* Spring Physics Bouncy Captions */}
      {captions && captions.length > 0 && (
        <BouncySubtitle words={captions} />
      )}

    </AbsoluteFill>
  );
};
