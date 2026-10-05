import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, AbsoluteFill } from 'remotion';

interface WordInfo {
  word: string;
  startSeconds: number;
  durationSeconds: number;
}

interface BouncySubtitleProps {
  words: WordInfo[];
}

export const BouncySubtitle: React.FC<BouncySubtitleProps> = ({ words }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '20px',
          padding: '40px',
          width: '80%',
        }}
      >
        {words.map((w, index) => {
          const startFrame = w.startSeconds * fps;
          const endFrame = (w.startSeconds + w.durationSeconds) * fps;

          // Check if word is active
          const isActive = frame >= startFrame && frame <= endFrame;
          
          // Animate scale using spring physics when active
          const scale = spring({
            frame: frame - startFrame,
            fps,
            config: {
              damping: 10,
              stiffness: 200,
              mass: 0.5,
            },
          });

          // Fallback static scale if not active, or hide if it's way past or not started
          // For typical viral clips, we show the word as it is spoken, then maybe keep it briefly
          const isVisible = frame >= startFrame && frame < endFrame + (fps * 1.5);

          if (!isVisible) return null;

          return (
            <div
              key={index}
              style={{
                fontFamily: 'Outfit, Inter, "Helvetica Neue", sans-serif',
                fontSize: '72px',
                fontWeight: '600',
                color: isActive ? '#FFFFFF' : 'rgba(255, 255, 255, 0.40)', // Active white, inactive faded
                transform: `scale(${isActive ? 1.05 : 1})`,
                transition: 'transform 0.08s ease-out, color 0.08s ease-out',
                textShadow: '0 4px 12px rgba(0,0,0,0.6)',
                margin: '10px',
                lineHeight: 1.2,
              }}
            >
              {w.word}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
