'use client';

import React, { useCallback, useEffect, useState } from 'react';
import useAudioTap, { Status } from './useAudioTap';
import useMicrophoneTranscription from './useMicrophoneTranscription';
import useCombinedTranscript from './useCombinedTranscript';
import { CreateMessage, Message, useChat } from '@ai-sdk/react';
import { CallSession, useCallSession } from './useCallSession';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useGenerateSpeechmaticsSession } from './useGenerateSpeechmaticsSession';
import resizeImage from './resizeImage';
import { toast } from 'sonner';
import { useSaveAiAnswers } from './useSaveAiAnswers';

type UseSessionTranscriptionProps = {
  callSessionId: string | null;
  version: string;
};

export default function useSessionTranscription({
  callSessionId,
  version,
}: UseSessionTranscriptionProps) {
  const queryClient = useQueryClient();

  const {
    data: callSession,
    isLoading: callSessionLoading,
    error: callSessionError,
  } = useCallSession(callSessionId);

  useEffect(() => {
    if (callSessionError) {
      toast.error(callSessionError.message);
    }
  }, [callSessionError]);

  // Session mutations
  const {
    mutateAsync: generateSpeechmaticsSession,
    isPending: generateSpeechmaticsSessionLoading,
    error: generateSpeechmaticsSessionError,
  } = useGenerateSpeechmaticsSession(version, callSessionId);

  useEffect(() => {
    if (generateSpeechmaticsSessionError) {
      toast.error(generateSpeechmaticsSessionError.message);
    }
  }, [generateSpeechmaticsSessionError]);

  // Transcription states
  const [startingMicrophoneTranscription, setStartingMicrophoneTranscription] =
    useState(false);

  // Combined transcript management
  const {
    addTranscript: addToCombinedTranscript,
    getCombinedTranscriptString,
    clearCombinedTranscript,
    combinedTranscript,
  } = useCombinedTranscript(callSession?.id, callSession?.saveTranscription);

  // audio tap transcription hook
  const {
    status: audioTapStatus,
    startTranscription: startAudioTapTranscription,
    stopRecording: stopAudioTapRecording,
    switchApiKey: switchAudioTapApiKey,
  } = useAudioTap(
    (transcript) => {
      if (!transcript) return;

      addToCombinedTranscript(transcript, 'share', false);
    },
    (partialTranscript) => {
      addToCombinedTranscript(partialTranscript, 'share', true);
    },
  );

  // Microphone transcription hook
  const {
    isRecording: isRecordingMicrophone,
    startTranscription: startMicrophoneTranscription,
    stopRecording: stopMicrophoneRecording,
    switchApiKey: switchMicrophoneApiKey,
  } = useMicrophoneTranscription(
    (transcript) => {
      if (!transcript) return;

      addToCombinedTranscript(transcript, 'microphone', false);
    },
    (partialTranscript) => {
      addToCombinedTranscript(partialTranscript, 'microphone', true);
    },
  );

  const { mutate: saveAiAnswer } = useSaveAiAnswers();

  // Chat functionality
  const { messages, append, stop, setMessages, status } = useChat({
    api: 'https://www.clozerai.com/api/chat',
    body: {
      callSessionId: callSession?.id,
      userId: callSession?.userId,
      workspaceId: callSession?.workspaceId,
    },
    onError: (error) => {
      toast.error(error.message);
    },
    onFinish: (message) => {
      if (
        message.role === 'assistant' &&
        callSession?.id &&
        callSession.saveTranscription
      ) {
        saveAiAnswer({
          callSessionId: callSession?.id,
          content: message.content,
          role: message.role,
          createdAt: message.createdAt || new Date(),
        });
      }
    },
  });

  function appendAndSave(message: Message | CreateMessage) {
    append(message);

    if (
      message.role === 'user' &&
      callSession?.id &&
      callSession.saveTranscription
    ) {
      saveAiAnswer({
        callSessionId: callSession?.id,
        content: message.content,
        role: message.role,
        createdAt: message.createdAt || new Date(),
      });
    }
  }

  const [chatInput, setChatInput] = useState('');

  // Session timer and expiration handling
  const [now, setTime] = useState<Date>(new Date());
  const sessionExpired = callSession && callSession.expired;
  const timeLeft = callSession?.endsAt
    ? new Date(callSession.endsAt).getTime() - now.getTime()
    : null;

  const [hasAutoExtended, setHasAutoExtended] = useState(false);
  const [
    hasChatActivitySinceLastExtension,
    setHasChatActivitySinceLastExtension,
  ] = useState(true);

  // Auto-extension logic
  const willAutoExtend = !!(
    callSession?.timeLeft &&
    callSession.timeLeft < 360000 &&
    !generateSpeechmaticsSessionLoading &&
    callSession.canExtend &&
    !callSession.trial &&
    hasChatActivitySinceLastExtension
  );

  const canAutoExtend = !!(
    callSession?.timeLeft &&
    callSession.timeLeft > 360000 &&
    !generateSpeechmaticsSessionLoading &&
    callSession.canExtend &&
    !callSession.trial &&
    hasChatActivitySinceLastExtension
  );

  // Session extended handler
  async function handleSessionExtended(newCallSession: CallSession) {
    queryClient.setQueryData(
      ['callSession', newCallSession.id],
      newCallSession,
    );

    let speechmaticsApiKey = newCallSession.speechmaticsApiKey;
    if (!speechmaticsApiKey) {
      const activatedCallSession = await generateSpeechmaticsSession();
      speechmaticsApiKey = activatedCallSession.speechmaticsApiKey;
    }

    if (audioTapStatus === Status.RECORDING) {
      switchAudioTapApiKey(speechmaticsApiKey!, newCallSession.language);
    }
    if (isRecordingMicrophone) {
      switchMicrophoneApiKey(speechmaticsApiKey!, newCallSession.language);
    }

    setHasChatActivitySinceLastExtension(false);
  }

  // Start audio tap recording
  const handleStartAudioTapTranscription = useCallback(async () => {
    if (!callSession) return;

    try {
      let speechmaticsApiKey = callSession.speechmaticsApiKey;
      if (!speechmaticsApiKey) {
        const activatedCallSession = await generateSpeechmaticsSession();
        speechmaticsApiKey = activatedCallSession.speechmaticsApiKey;
      }

      await startAudioTapTranscription(
        speechmaticsApiKey!,
        callSession.language,
      );
    } catch (error) {
      console.error('Audio tap transcription error:', error);
    }
  }, [callSession, generateSpeechmaticsSession, startAudioTapTranscription]);

  // Start microphone transcription
  const handleStartMicrophoneTranscription = useCallback(async () => {
    if (!callSession) return;

    setStartingMicrophoneTranscription(true);

    try {
      let speechmaticsApiKey = callSession.speechmaticsApiKey;
      if (!speechmaticsApiKey) {
        const activatedCallSession = await generateSpeechmaticsSession();
        speechmaticsApiKey = activatedCallSession.speechmaticsApiKey;
      }

      await startMicrophoneTranscription(
        speechmaticsApiKey!,
        callSession.language,
      );
    } finally {
      setStartingMicrophoneTranscription(false);
    }
  }, [callSession, generateSpeechmaticsSession, startMicrophoneTranscription]);

  // Stop microphone transcription
  const handleStopMicrophoneTranscription = useCallback(() => {
    stopMicrophoneRecording();
  }, [stopMicrophoneRecording]);

  // Chat message preparation
  const prepareMessagesForNewMessage = useCallback(() => {
    // Keep at most last 10 messages and remove images from any older user messages
    const newMessages = messages.slice(-10).map((m, idx, arr) => {
      const isLast = idx === arr.length - 1;
      // @ts-expect-error
      if (m.role === 'user' && m.data?.imageUrl && !isLast) {
        // @ts-expect-error
        return { ...m, data: { ...m.data, imageUrl: undefined } };
      }
      return m;
    });
    setMessages(newMessages);
  }, [messages, setMessages]);

  // Generate AI response
  const handleGenerateResponse = useCallback(
    async (task: 'ai-help' | 'what-to-say' | 'direct-message') => {
      setHasChatActivitySinceLastExtension(true);

      stop();
      await new Promise((resolve) => setTimeout(resolve, 0));

      prepareMessagesForNewMessage();

      let content =
        task === 'direct-message'
          ? '**Direct Message from Sales Agent**: ' + chatInput
          : chatInput || getCombinedTranscriptString();

      // Pass task in message data instead of appending to content
      appendAndSave({
        role: 'user',
        content,
        data: { task },
      });

      if (task === 'direct-message') {
        setChatInput('');
      } else {
        clearCombinedTranscript();
      }
    },
    [
      stop,
      prepareMessagesForNewMessage,
      appendAndSave,
      getCombinedTranscriptString,
      clearCombinedTranscript,
    ],
  );

  const {
    mutateAsync: captureScreenshotMutate,
    isPending: isCapturingScreenshot,
    error: captureScreenshotError,
  } = useMutation({
    mutationFn: window.electron?.ipcRenderer.captureScreenshot,
  });

  useEffect(() => {
    if (captureScreenshotError) {
      toast.error(captureScreenshotError.message);
    }
  }, [captureScreenshotError]);

  const handleGenerateResponseWithScreenshot = useCallback(async () => {
    setHasChatActivitySinceLastExtension(true);

    stop();

    try {
      const dataUrl = await captureScreenshotMutate();

      // Resize the image to max 1080p before sending
      const resizedDataUrl = await resizeImage(dataUrl);

      prepareMessagesForNewMessage();

      // Send as a new user message containing text + image
      appendAndSave({
        role: 'user',
        content:
          "This is a screenshot of the callee's screen. Analyze the screen and provide a useful response.",
        data: { imageUrl: resizedDataUrl },
      });
    } catch (err) {
      console.error('Listen error:', err);
    }
  }, [
    stop,
    captureScreenshotMutate,
    appendAndSave,
    prepareMessagesForNewMessage,
  ]);

  // Stop all recordings
  const handleStopAllRecording = useCallback(() => {
    stopAudioTapRecording();
    stopMicrophoneRecording();
  }, [stopAudioTapRecording, stopMicrophoneRecording]);

  // Clear all chat messages
  const handleClearAllAnswers = useCallback(() => {
    stop();
    setMessages([]);
  }, [stop, setMessages]);

  // Effects

  // Timer update effect
  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => {
      clearInterval(interval);
    };
  }, []);

  // Stop recording when session expires
  useEffect(() => {
    if (sessionExpired) {
      handleStopAllRecording();
    }
  }, [sessionExpired, stopAudioTapRecording, stopMicrophoneRecording]);

  // Auto-extension logic
  useEffect(() => {
    if (willAutoExtend && timeLeft && timeLeft < 60000 && !hasAutoExtended) {
      setHasAutoExtended(true);
      if (callSession) {
        handleSessionExtended(callSession);
      }
    }
  }, [
    willAutoExtend,
    timeLeft,
    hasAutoExtended,
    callSession,
    handleSessionExtended,
  ]);

  useEffect(() => {
    if (timeLeft && timeLeft > 60000 && hasAutoExtended) {
      setHasAutoExtended(false);
    }
  }, [timeLeft, hasAutoExtended]);

  return {
    // Call session data
    callSession,
    callSessionLoading,
    callSessionError,

    // Generate speechmatics session
    generateSpeechmaticsSession,
    generateSpeechmaticsSessionLoading,
    generateSpeechmaticsSessionError,

    // Session expiration
    sessionExpired,
    timeLeft,
    willAutoExtend,
    canAutoExtend,

    // Audio tap transcription
    audioTapStatus,
    handleStartAudioTapTranscription,
    stopAudioTapRecording,

    // Microphone transcription
    isRecordingMicrophone,
    startingMicrophoneTranscription,
    handleStartMicrophoneTranscription,
    handleStopMicrophoneTranscription,

    // Screenshot functionality
    isCapturingScreenshot,
    handleGenerateResponseWithScreenshot,

    // Chat functionality
    messages,
    isLoading: status === 'submitted' || status === 'streaming',
    chatInput,
    setChatInput,
    handleGenerateResponse,
    handleClearAllAnswers,

    // Combined transcript
    combinedTranscript,
    clearTranscripts: clearCombinedTranscript,
  };
}
