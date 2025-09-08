import React, { useState } from 'react';
import { GoogleGenAI } from '@google/genai';
import { marked } from 'marked';
import Spinner from '../components/common/Spinner';

// Type for grounding chunks
interface GroundingChunk {
  web: {
    uri: string;
    title: string;
  };
}

const ResearchPage: React.FC = () => {
  const [prompt, setPrompt] = useState<string>('');
  const [report, setReport] = useState<string>('');
  const [sources, setSources] = useState<GroundingChunk[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const handleGenerateReport = async () => {
    if (!prompt.trim()) {
      setError('Veuillez entrer un sujet de recherche.');
      return;
    }
    setLoading(true);
    setError('');
    setReport('');
    setSources([]);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: `Générez un rapport de recherche détaillé et bien structuré sur le sujet suivant : "${prompt}". Utilisez des titres, des listes et des mises en évidence pour une meilleure lisibilité.`,
        config: {
          tools: [{ googleSearch: {} }],
        },
      });

      const reportText = response.text;
      const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

      setReport(reportText);
      setSources(groundingChunks);

    } catch (err: any) {
      console.error('Gemini API error:', err);
      setError(`Une erreur est survenue lors de la génération du rapport : ${err.message || 'Erreur inconnue'}`);
    } finally {
      setLoading(false);
    }
  };
  
  const parsedReport = marked.parse(report);


  return (
    <div className="space-y-6">
      <h2 className="text-2xl sm:text-3xl font-bold text-white">Assistant de Recherche IA</h2>
      <p className="text-gray-400">
        Entrez un sujet (par exemple, "l'impact de la technologie blockchain sur la finance" ou "analyse comparative de Solana et Ethereum")
        et l'IA générera un rapport en utilisant les dernières informations du web.
      </p>

      <div className="bg-[#14181f]/50 border border-[#2b2f38] rounded-lg p-6 shadow-lg space-y-4">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Entrez votre sujet de recherche ici..."
          rows={4}
          disabled={loading}
          className="block w-full rounded-md border-[#3e4451] bg-[#0c0e12]/50 p-3 shadow-sm focus:border-[#f0b90b] focus:ring-[#f0b90b] sm:text-sm text-white disabled:opacity-50"
        />
        <button
          onClick={handleGenerateReport}
          disabled={loading}
          className="inline-flex items-center justify-center rounded-md border border-transparent bg-[#f0b90b] px-6 py-2 text-sm font-semibold text-black shadow-sm hover:bg-yellow-500 focus:outline-none focus:ring-2 focus:ring-[#f0b90b] focus:ring-offset-2 focus:ring-offset-[#14181f] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <>
              <Spinner size="sm" />
              <span className="ml-2">Génération en cours...</span>
            </>
          ) : (
            'Générer le Rapport'
          )}
        </button>
      </div>

      {error && (
        <div className="bg-red-900/50 border border-red-700 rounded-lg p-4 text-red-300">
          <p className="font-bold">Erreur</p>
          <p>{error}</p>
        </div>
      )}

      {loading && (
        <div className="flex flex-col items-center justify-center bg-[#14181f]/50 border border-[#2b2f38] rounded-lg p-10 shadow-lg">
            <Spinner />
            <p className="mt-4 text-gray-300">Recherche sur le web et compilation du rapport...</p>
            <p className="text-sm text-gray-500">Cette opération peut prendre un moment.</p>
        </div>
      )}

      {report && (
        <div className="bg-[#14181f]/50 border border-[#2b2f38] rounded-lg p-6 shadow-lg space-y-6">
          <h3 className="text-xl font-bold text-white border-b border-[#2b2f38] pb-3">Rapport de Recherche</h3>
          <div
            className="prose prose-invert prose-headings:text-[#f0b90b] prose-a:text-sky-400 hover:prose-a:text-sky-300 max-w-none"
            dangerouslySetInnerHTML={{ __html: parsedReport as string }}
          />

          {sources.length > 0 && (
            <div className="border-t border-[#2b2f38] pt-4">
              <h4 className="text-lg font-semibold text-white mb-2">Sources</h4>
              <ul className="list-disc list-inside space-y-2">
                {sources.map((source, index) => (
                  <li key={index} className="text-gray-400">
                    <a
                      href={source.web.uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sky-400 hover:text-sky-300 hover:underline"
                    >
                      {source.web.title || source.web.uri}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ResearchPage;
