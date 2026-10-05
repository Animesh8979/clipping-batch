let zod = null;
try {
  zod = require('zod');
} catch (_) {
  zod = null;
}
const {repairMojibakeText} = require('./text-repair');

function compactText(value) {
  return repairText(value).replace(/\s+/g, ' ').trim();
}

function looksMojibake(text) {
  return /ÃƒÆ’|Ãƒâ€š|ÃƒÂ¢Ã¢â€šÂ¬|Ã Â¤|Ã¢â‚¬â„¢|Ã¢â‚¬Å“|Ã¢â‚¬\u009d|Ã¢â‚¬\u0098|Ã¢â‚¬\u0099/u.test(String(text || ''));
}

function repairText(text) {
  return repairMojibakeText(text);
}

function createFallbackScene(sentence, topic, index) {
  const baseTopic = compactText(topic).split(/\?|:|!/)[0] || 'global story';
  return {
    sentence,
    sentenceEnglish: sentence,
    sentenceHindi: null,
    durationWeight: 1,
    literalSearchTerm: `${baseTopic} visual`,
    fallbackVibeTerm: `${baseTopic} cinematic`,
    portraitSearchTerm: `${baseTopic} portrait`,
    index,
  };
}

function repairScenes(rawScenes, topic) {
  const scenes = Array.isArray(rawScenes) ? rawScenes : [];
  const repaired = scenes
    .map((scene, index) => {
      if (typeof scene === 'string') {
        return createFallbackScene(compactText(scene), topic, index);
      }
      if (!scene || typeof scene !== 'object') {
        return null;
      }
      const sentence = compactText(scene.sentence || scene.sentenceEnglish || scene.sentenceHindi);
      const sentenceEnglish = compactText(scene.sentenceEnglish || scene.sentence);
      const sentenceHindi = compactText(scene.sentenceHindi);
      if (!sentence) {
        return null;
      }
      return {
        sentence,
        sentenceEnglish: sentenceEnglish || null,
        sentenceHindi: sentenceHindi || null,
        durationWeight: Number(scene.durationWeight) > 0 ? Number(scene.durationWeight) : 1,
        literalSearchTerm: compactText(scene.literalSearchTerm) || `${compactText(topic)} visual`,
        fallbackVibeTerm: compactText(scene.fallbackVibeTerm) || `${compactText(topic)} cinematic`,
        portraitSearchTerm: compactText(scene.portraitSearchTerm) || `${compactText(topic)} portrait`,
        index,
      };
    })
    .filter(Boolean);

  return repaired;
}

function repairPayloadShape(rawPayload, topic) {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return null;
  }

  const repairedScenes = repairScenes(rawPayload.scenes, topic);
  const scriptText = compactText(rawPayload.scriptText) || repairedScenes.map((scene) => scene.sentence).join(' ');

  if (!scriptText || repairedScenes.length === 0) {
    return null;
  }

  return {
    ...rawPayload,
    scriptText,
    scriptTextHindi: compactText(rawPayload.scriptTextHindi) || null,
    scriptTextEnglish: compactText(rawPayload.scriptTextEnglish) || null,
    scenes: repairedScenes,
  };
}

function validatePayloadShape(rawPayload) {
  if (!zod) {
    return {success: Boolean(rawPayload && typeof rawPayload === 'object')};
  }

  const SceneSchema = zod.z.object({
    sentence: zod.z.string().min(4),
    durationWeight: zod.z.number().positive().optional(),
    literalSearchTerm: zod.z.string().optional(),
    fallbackVibeTerm: zod.z.string().optional(),
    portraitSearchTerm: zod.z.string().optional(),
  });

  const PayloadSchema = zod.z.object({
    scriptText: zod.z.string().min(20),
    scenes: zod.z.array(SceneSchema).min(1),
    scriptTextHindi: zod.z.string().nullable().optional(),
    scriptTextEnglish: zod.z.string().nullable().optional(),
    contentType: zod.z.string().nullable().optional(),
    language: zod.z.string().nullable().optional(),
    storyPart: zod.z.number().nullable().optional(),
    seriesTitle: zod.z.string().nullable().optional(),
  });

  return PayloadSchema.safeParse(rawPayload);
}

function doctorRepairPayload(rawPayload, topic) {
  const repaired = repairPayloadShape(rawPayload, topic);
  if (!repaired) {
    return null;
  }
  const validation = validatePayloadShape(repaired);
  return validation.success ? repaired : null;
}

module.exports = {
  doctorRepairPayload,
};
