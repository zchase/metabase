import React, { useCallback, useMemo, useRef, useState } from "react";
import cx from "classnames";
import _ from "underscore";
import { getIn } from "icepick";
import { t } from "ttag";
import { connect } from "react-redux";
import { LocationDescriptor } from "history";

import { IconProps } from "metabase/components/Icon";

import { IS_EMBED_PREVIEW } from "metabase/lib/embed";
import { SERVER_ERROR_TYPES } from "metabase/lib/errors";
import Utils from "metabase/lib/utils";

import { useOnMount } from "metabase/hooks/use-on-mount";

import { isVirtualDashCard } from "metabase/dashboard/utils";

import { mergeSettings } from "metabase/visualizations/lib/settings";
import Visualization, {
  ERROR_MESSAGE_GENERIC,
  ERROR_MESSAGE_PERMISSION,
} from "metabase/visualizations/components/Visualization";
import WithVizSettingsData from "metabase/visualizations/hoc/WithVizSettingsData";

import QueryDownloadWidget from "metabase/query_builder/components/QueryDownloadWidget";

import { getParameterValuesBySlug } from "metabase/parameters/utils/parameter-values";

import Mode from "metabase-lib/lib/Mode";
import Metadata from "metabase-lib/lib/metadata/Metadata";

import { VisualizationSettings } from "metabase-types/api/card";
import { CardId, SavedCard } from "metabase-types/types/Card";
import {
  DashboardWithCards,
  DashCard as IDashCard,
  DashCardId,
} from "metabase-types/types/Dashboard";
import { DatasetData } from "metabase-types/types/Dataset";
import {
  ParameterId,
  ParameterValueOrArray,
} from "metabase-types/types/Parameter";
import { Dispatch } from "metabase-types/store";

import DashCardParameterMapper from "../DashCardParameterMapper";
import ClickBehaviorSidebarOverlay from "./ClickBehaviorSidebarOverlay";
import DashCardActionButtons from "./DashCardActionButtons";
import { DashCardRoot, DashboardCardActionsPanel } from "./DashCard.styled";

const DATASET_USUALLY_FAST_THRESHOLD = 15 * 1000;

// This is done to add the `getExtraDataForClick` prop.
// We need that to pass relevant data along with the clicked object.
const WrappedVisualization = WithVizSettingsData(
  connect(null, dispatch => ({ dispatch }))(Visualization),
);

type FetchCardDataOpts = {
  reload?: boolean;
  clear?: boolean;
  ignoreCache?: boolean;
};

type NavigateToNewCardFromDashboardOpts = {
  nextCard: SavedCard;
  previousCard: SavedCard;
  dashcard: IDashCard;
  objectId?: unknown;
};

type CardIsSlow = "usually-fast" | "usually-slow" | false;

interface DashCardProps {
  dashboard: DashboardWithCards;
  dashcard: IDashCard & { justAdded?: boolean };
  gridItemWidth: number;
  totalNumGridCols: number;
  dashcardData: Record<DashCardId, Record<CardId, DatasetData>>;
  slowCards: Record<CardId, boolean>;
  parameterValues: Record<ParameterId, ParameterValueOrArray>;
  metadata: Metadata;
  mode?: Mode;

  clickBehaviorSidebarDashcard?: IDashCard | null;

  isEditing?: boolean;
  isEditingParameter?: boolean;
  isFullscreen?: boolean;
  isMobile?: boolean;
  isNightMode?: boolean;

  headerIcon?: IconProps;

  dispatch: Dispatch;
  onAddSeries: () => void;
  onRemove: () => void;
  markNewCardSeen: (dashcardId: DashCardId) => void;
  fetchCardData: (
    card: SavedCard,
    dashCard: IDashCard,
    opts?: FetchCardDataOpts,
  ) => void;
  navigateToNewCardFromDashboard: (
    opts: NavigateToNewCardFromDashboardOpts,
  ) => void;
  onReplaceAllVisualizationSettings: (settings: VisualizationSettings) => void;
  onUpdateVisualizationSettings: (settings: VisualizationSettings) => void;
  showClickBehaviorSidebar: (dashCardId: DashCardId) => void;
  onChangeLocation: (location: LocationDescriptor) => void;
}

function preventDragging(e: React.SyntheticEvent) {
  e.stopPropagation();
}

function DashCard({
  dashcard,
  dashcardData,
  dashboard,
  slowCards,
  metadata,
  parameterValues,
  gridItemWidth,
  totalNumGridCols,
  mode,
  isEditing = false,
  isNightMode = false,
  isFullscreen = false,
  isMobile = false,
  isEditingParameter,
  clickBehaviorSidebarDashcard,
  headerIcon,
  onAddSeries,
  onRemove,
  navigateToNewCardFromDashboard,
  markNewCardSeen,
  showClickBehaviorSidebar,
  onChangeLocation,
  onUpdateVisualizationSettings,
  onReplaceAllVisualizationSettings,
  dispatch,
}: DashCardProps) {
  const [isPreviewingCard, setIsPreviewingCard] = useState(false);
  const cardRootRef = useRef<HTMLDivElement>(null);

  const handlePreviewToggle = useCallback(() => {
    setIsPreviewingCard(wasPreviewingCard => !wasPreviewingCard);
  }, []);

  useOnMount(() => {
    if (dashcard.justAdded) {
      cardRootRef?.current?.scrollIntoView({
        block: "nearest",
      });
      markNewCardSeen(dashcard.id);
    }
  });

  const mainCard: SavedCard = useMemo(
    () => ({
      ...dashcard.card,
      visualization_settings: mergeSettings(
        dashcard.card.visualization_settings,
        dashcard.visualization_settings,
      ),
    }),
    [dashcard],
  );

  const dashboardId = dashcard.dashboard_id;
  const isEmbed = Utils.isJWT(dashboardId);

  const cards = useMemo(() => {
    if (Array.isArray(dashcard.series)) {
      return [mainCard, ...dashcard.series];
    }
    return [mainCard];
  }, [mainCard, dashcard]);

  const series = useMemo(() => {
    return cards.map(card => ({
      ...getIn(dashcardData, [dashcard.id, card.id]),
      card: card,
      isSlow: slowCards[card.id],
      isUsuallyFast:
        card.query_average_duration &&
        card.query_average_duration < DATASET_USUALLY_FAST_THRESHOLD,
    }));
  }, [cards, dashcard.id, dashcardData, slowCards]);

  const isLoading = useMemo(() => {
    if (isVirtualDashCard(dashcard)) {
      return false;
    }
    const hasSeries = series.length > 0 && series.every(s => s.data);
    return !hasSeries;
  }, [dashcard, series]);

  const { expectedDuration, isSlow } = useMemo(() => {
    const expectedDuration = Math.max(
      ...series.map(s => s.card.query_average_duration || 0),
    );
    const isUsuallyFast = series.every(s => s.isUsuallyFast);
    let isSlow: CardIsSlow = false;
    if (isLoading && series.some(s => s.isSlow)) {
      isSlow = isUsuallyFast ? "usually-fast" : "usually-slow";
    }
    return { expectedDuration, isSlow };
  }, [series, isLoading]);

  const isAccessRestricted = series.some(
    s =>
      s.error_type === SERVER_ERROR_TYPES.missingPermissions ||
      s.error?.status === 403,
  );

  const errors = series.map(s => s.error).filter(e => e);

  let errorMessage, errorIcon;
  if (isAccessRestricted) {
    errorMessage = ERROR_MESSAGE_PERMISSION;
    errorIcon = "key";
  } else if (errors.length > 0) {
    if (IS_EMBED_PREVIEW) {
      errorMessage = (errors[0] && errors[0].data) || ERROR_MESSAGE_GENERIC;
    } else {
      errorMessage = ERROR_MESSAGE_GENERIC;
    }
    errorIcon = "warning";
  }

  const parameterValuesBySlug = getParameterValuesBySlug(
    dashboard.parameters,
    parameterValues,
  );

  const hideBackground =
    !isEditing &&
    mainCard.visualization_settings["dashcard.background"] === false;

  const isEditingDashboardLayout =
    isEditing && clickBehaviorSidebarDashcard == null && !isEditingParameter;

  const gridSize = { width: dashcard.sizeX, height: dashcard.sizeY };

  return (
    <DashCardRoot
      className="Card rounded flex flex-column hover-parent hover--visibility"
      style={
        hideBackground
          ? { border: 0, background: "transparent", boxShadow: "none" }
          : undefined
      }
      isNightMode={isNightMode}
      isUsuallySlow={isSlow === "usually-slow"}
      ref={cardRootRef}
    >
      {isEditingDashboardLayout ? (
        <DashboardCardActionsPanel onMouseDown={preventDragging}>
          <DashCardActionButtons
            series={series}
            isLoading={isLoading}
            isVirtualDashCard={isVirtualDashCard(dashcard)}
            hasError={!!errorMessage}
            onRemove={onRemove}
            onAddSeries={onAddSeries}
            onReplaceAllVisualizationSettings={
              onReplaceAllVisualizationSettings
            }
            showClickBehaviorSidebar={() =>
              showClickBehaviorSidebar(dashcard.id)
            }
            isPreviewing={isPreviewingCard}
            onPreviewToggle={handlePreviewToggle}
            dashboard={dashboard}
          />
        </DashboardCardActionsPanel>
      ) : null}
      <WrappedVisualization
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        className={cx("flex-full overflow-hidden", {
          "pointer-events-none": isEditingDashboardLayout,
        })}
        classNameWidgets={isEmbed && "text-light text-medium-hover"}
        error={errorMessage}
        headerIcon={headerIcon}
        errorIcon={errorIcon}
        isSlow={isSlow}
        expectedDuration={expectedDuration}
        rawSeries={series}
        showTitle
        isFullscreen={isFullscreen}
        isNightMode={isNightMode}
        isDashboard
        dispatch={dispatch}
        dashboard={dashboard}
        dashcard={dashcard}
        parameterValues={parameterValues}
        parameterValuesBySlug={parameterValuesBySlug}
        isEditing={isEditing}
        isPreviewing={isPreviewingCard}
        isEditingParameter={isEditingParameter}
        isMobile={isMobile}
        gridSize={gridSize}
        totalNumGridCols={totalNumGridCols}
        actionButtons={
          isEmbed ? (
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            <QueryDownloadWidget
              className="m1 text-brand-hover text-light"
              classNameClose="hover-child"
              card={dashcard.card}
              params={parameterValuesBySlug}
              dashcardId={dashcard.id}
              token={dashcard.dashboard_id}
              icon="download"
            />
          ) : null
        }
        onUpdateVisualizationSettings={onUpdateVisualizationSettings}
        replacementContent={
          clickBehaviorSidebarDashcard != null &&
          isVirtualDashCard(dashcard) ? (
            <div className="flex full-height align-center justify-center">
              <h4 className="text-medium">{t`Text card`}</h4>
            </div>
          ) : isEditingParameter ? (
            <DashCardParameterMapper dashcard={dashcard} isMobile={isMobile} />
          ) : clickBehaviorSidebarDashcard != null ? (
            <ClickBehaviorSidebarOverlay
              dashcard={dashcard}
              dashcardWidth={gridItemWidth}
              showClickBehaviorSidebar={showClickBehaviorSidebar}
              isShowingThisClickBehaviorSidebar={
                clickBehaviorSidebarDashcard?.id === dashcard.id
              }
            />
          ) : null
        }
        metadata={metadata}
        mode={mode}
        onChangeCardAndRun={
          navigateToNewCardFromDashboard
            ? ({
                nextCard,
                previousCard,
                objectId,
              }: Omit<NavigateToNewCardFromDashboardOpts, "dashcard">) => {
                // navigateToNewCardFromDashboard needs `dashcard` for applying active filters to the query
                navigateToNewCardFromDashboard({
                  nextCard,
                  previousCard,
                  dashcard,
                  objectId,
                });
              }
            : null
        }
        onChangeLocation={onChangeLocation}
      />
    </DashCardRoot>
  );
}

export default DashCard;
